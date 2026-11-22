import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Aurral gives each status call a minute. Copy files for at most this long
// per call and pick up the rest on the next one.
const COPY_BUDGET_MS = 25_000;
const FILE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 50_000;

const trimSlashes = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[\\/]+$/, "");

async function problem(response) {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `Downtify answered ${response.status}`;
}

const client = (settings) =>
  async function call(route, { method = "GET", body, params, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const base = trimSlashes(settings.url);
    const url = new URL(`${base}/api/aurral${route}`);
    for (const [name, value] of Object.entries(params ?? {}))
      if (value != null && value !== "") url.searchParams.set(name, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${String(settings.key ?? "").trim()}`,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    }).catch(() => {
      throw new Error(`Couldn't reach Downtify at ${base}`);
    });
    if (response.status === 401)
      throw new Error("Downtify rejected the key. Make a new one under Settings > Apps > Aurral.");
    // A Downtify from before Aurral support keeps these routes from apps.
    if (response.status === 403)
      throw new Error(
        "This Downtify doesn't support Aurral yet. Update Downtify, then make a key under Settings > Apps > Aurral.",
      );
    if (response.status === 404 && route.startsWith("/jobs/"))
      throw new Error("Downtify no longer has this download. It may have restarted.");
    if (response.status === 404)
      throw new Error("This Downtify doesn't know Aurral yet. Update Downtify.");
    if (!response.ok) throw new Error(await problem(response));
    return response;
  };

const json = async (response) => response.json();

// A file name from Downtify, kept inside the download's folder.
const safeName = (name, index) =>
  path.basename(String(name ?? "").replace(/[\\/]+/g, "_")).replace(/^\.+/, "") ||
  `track-${index + 1}`;

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

async function copyFile(call, jobId, file, directory) {
  const target = path.join(directory, safeName(file.name, file.index));
  if ((await sizeOf(target)) === file.size) return target;
  const partial = `${target}.part`;
  const response = await call(`/jobs/${encodeURIComponent(jobId)}/files/${file.index}`, {
    timeout: FILE_TIMEOUT_MS,
  });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`Couldn't copy ${file.name} from Downtify: ${error.message}`);
  }
  return target;
}

async function start(settings, body) {
  const job = await json(await client(settings)("/jobs", { method: "POST", body }));
  return { pending: job.id };
}

export default {
  async test({ settings }) {
    const about = await json(await client(settings)(""));
    if (!about.enabled)
      throw new Error(
        "Downtify is reachable, but Aurral downloads are off there. Turn them on under Settings > Apps > Aurral.",
      );
    if (about.library_only)
      throw new Error("Downtify is in library-only mode, so it downloads nothing.");
    return { message: `Connected to Downtify ${about.version}` };
  },
  downloadSource: {
    async search({ settings, track }) {
      if (!track.title) return [];
      const response = await client(settings)("/search/tracks", {
        params: { artist: track.artist, title: track.title, album: track.album },
        timeout: SEARCH_TIMEOUT_MS,
      });
      return (await json(response)).slice(0, 50);
    },
    download({ settings, result }) {
      return start(settings, { song: result.data?.song });
    },
    async searchAlbum({ settings, album }) {
      if (!album.title) return [];
      const response = await client(settings)("/search/albums", {
        params: { artist: album.artist, title: album.title },
        timeout: SEARCH_TIMEOUT_MS,
      });
      return (await json(response)).slice(0, 50);
    },
    downloadAlbum({ settings, result }) {
      return start(settings, { album_url: result.data?.url });
    },
    async status({ settings, id, directory }) {
      const call = client(settings);
      const job = await json(await call(`/jobs/${encodeURIComponent(id)}`));
      if (job.status === "failed") throw new Error(job.message || "Downtify couldn't download it");
      if (job.status !== "done") return { done: false };
      const began = Date.now();
      const copied = [];
      for (const file of job.files) {
        if (Date.now() - began > COPY_BUDGET_MS) return { done: false };
        copied.push(await copyFile(call, id, file, directory));
      }
      // Aurral has the files: Downtify can drop its copy.
      await call(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
      if (job.kind === "track") return { done: true, path: path.basename(copied[0]) };
      return { done: true };
    },
    async discard({ settings, id }) {
      await client(settings)(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
        () => {},
      );
    },
  },
};
