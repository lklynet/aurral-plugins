import { readdir } from "node:fs/promises";

const TAG = "aurral-plugin";
const STUCK = new Set(["importBlocked", "importFailed"]);

const trimSlashes = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[\\/]+$/, "");

async function problem(response) {
  const body = await response.json().catch(() => null);
  const detail = Array.isArray(body) ? body[0]?.errorMessage : body?.message;
  return detail
    ? `Lidarr answered ${response.status}: ${detail}`
    : `Lidarr answered ${response.status}`;
}

const client = (settings) =>
  async function call(path, body, method = body ? "POST" : "GET") {
    const base = trimSlashes(settings.url);
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "X-Api-Key": settings.apiKey, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new Error(`Couldn't reach Lidarr at ${base}`);
    });
    if (response.status === 401) throw new Error("Lidarr rejected the API key");
    if (!response.ok) throw new Error(await problem(response));
    return response.json();
  };

function aurralPath(settings, path) {
  const from = trimSlashes(settings.lidarrPath);
  const to = trimSlashes(settings.aurralPath);
  if (!from || !to) return path;
  return path === from || path.startsWith(from + "/") ? to + path.slice(from.length) : path;
}

function newArtistRoot(settings, roots) {
  const wanted = trimSlashes(settings.rootFolder);
  const root = wanted ? roots.find((entry) => trimSlashes(entry.path) === wanted) : roots[0];
  if (root) return root;
  throw new Error(
    wanted
      ? `Lidarr has no root folder at ${wanted}`
      : "Lidarr has no root folder. Add one in Lidarr first.",
  );
}

async function ownTag(call) {
  const tags = await call("/tag");
  return tags.find((tag) => tag.label === TAG) ?? call("/tag", { label: TAG });
}

const lookup = async (call, mbid) => (await call(`/album/lookup?term=lidarr:${mbid}`))[0];

const complete = ({ statistics }) =>
  statistics?.trackCount > 0 && statistics.trackFileCount >= statistics.trackCount;

async function searching(call, albumId) {
  const commands = await call("/command");
  return commands.some(
    (command) =>
      command.name === "AlbumSearch" &&
      command.body?.albumIds?.includes(albumId) &&
      (command.status === "queued" || command.status === "started"),
  );
}

async function addAlbum(call, settings, found) {
  if (!found) throw new Error("Lidarr can't find this album any more");
  if (found.artist.id) return call("/album", { ...found, monitored: true });
  const root = newArtistRoot(settings, await call("/rootfolder"));
  const tag = await ownTag(call);
  return call("/album", {
    ...found,
    monitored: true,
    artist: {
      ...found.artist,
      monitored: true,
      monitorNewItems: "none",
      rootFolderPath: root.path,
      qualityProfileId: root.defaultQualityProfileId,
      metadataProfileId: root.defaultMetadataProfileId,
      tags: [tag.id],
      addOptions: {
        monitor: "missing",
        albumsToMonitor: [found.foreignAlbumId],
        searchForMissingAlbums: false,
      },
    },
  });
}

export default {
  async test({ settings }) {
    const call = client(settings);
    const [{ version }, roots] = await Promise.all([call("/system/status"), call("/rootfolder")]);
    newArtistRoot(settings, roots);
    for (const root of roots) {
      const folder = aurralPath(settings, root.path);
      await readdir(folder).catch(() => {
        throw new Error(
          `Aurral can't open ${folder}, where Lidarr keeps music. If Aurral sees that folder at another path, fill in both path settings.`,
        );
      });
    }
    return { message: `Connected to Lidarr ${version}` };
  },
  downloadSource: {
    async searchAlbum({ settings, album }) {
      if (!album.releaseGroupMbid) return [];
      const found = await lookup(client(settings), album.releaseGroupMbid);
      if (!found) return [];
      return [
        {
          id: found.foreignAlbumId,
          title: found.title,
          artist: found.artist.artistName,
          year: Number(found.releaseDate?.slice(0, 4)) || null,
        },
      ];
    },
    async downloadAlbum({ settings, result }) {
      const call = client(settings);
      const [existing] = await call(`/album?foreignAlbumId=${result.id}`);
      const album = existing ?? (await addAlbum(call, settings, await lookup(call, result.id)));
      if (complete(album)) return { pending: `${album.id}@` };
      if (!album.monitored)
        await call("/album/monitor", { albumIds: [album.id], monitored: true }, "PUT");
      const search = await call("/command", { name: "AlbumSearch", albumIds: [album.id] });
      return { pending: `${album.id}@${search.queued}` };
    },
    async status({ settings, id }) {
      const call = client(settings);
      const [albumId, since] = id.split("@");
      const finish = async () => {
        const files = await call(`/trackfile?albumId=${albumId}`);
        if (!files.length) throw new Error("Lidarr found nothing to download for this album");
        return { done: true, imported: files.map((file) => aurralPath(settings, file.path)) };
      };
      if (complete(await call(`/album/${albumId}`))) return finish();
      const queue = await call(`/queue/details?albumIds=${albumId}`);
      const stuck = queue.find((item) => STUCK.has(item.trackedDownloadState));
      if (stuck) {
        const reason = stuck.statusMessages?.flatMap((entry) => entry.messages ?? [])[0];
        throw new Error(`Lidarr couldn't import ${stuck.title}${reason ? `: ${reason}` : ""}`);
      }
      if (queue.length || (await searching(call, Number(albumId)))) return { done: false };
      const { records } = await call(
        `/history?albumId=${albumId}&pageSize=1&sortKey=date&sortDirection=descending`,
      );
      const last = records[0]?.date >= since ? records[0].eventType : null;
      if (last === "grabbed") return { done: false };
      if (last === "downloadFailed") throw new Error("Lidarr's download failed");
      return finish();
    },
    discard() {},
  },
};
