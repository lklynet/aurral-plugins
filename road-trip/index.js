import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USER_AGENT = "AurralRoadTrip/1.0 ( https://github.com/lklynet/aurral-plugins )";
const CACHE_VERSION = 3;
const BUDGET_MS = 65_000;
const MAX_SAMPLES = 80;
const MIN_SAMPLE_KM = 10;
const MAX_LEG_KM = 1200;
const TOWN_RADIUS_KM = 6;
const MAX_TOWN_SEARCHES = 45;
const SONGS_PER_TOWN = 2;
const SLOT_SECONDS = 15 * 60;
const AVERAGE_SONG_SECONDS = 220;
const TRACKS_PER_ARTIST = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  return response.json();
}

const postJson = (url, body) =>
  getJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function mapLimit(items, limit, deadline, fn) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++];
      results.push(await fn(item).catch(() => []));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results.flat();
}

const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const plain = (text) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const words = (text) => plain(text).toLowerCase();
const titleCase = (text) => text.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

const songKey = (song) =>
  `${words(song.artist)}|${words(song.title.replace(/\(.*?\)|\[.*?\]|\s-\s.*$/g, "")).trim()}`;

async function resolveLink(link) {
  if (!new URL(link).hostname.endsWith("goo.gl")) return link;
  const response = await fetch(link, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const location = response.headers.get("location");
  if (!location) throw new Error("That short link didn't open directions in Google Maps");
  return location;
}

const COORDINATE = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/;

function parseDirections(link) {
  const url = new URL(link);
  const query = url.searchParams;
  const stops =
    query.get("api") === "1"
      ? [query.get("origin"), ...(query.get("waypoints")?.split("|") ?? []), query.get("destination")]
      : pathStops(url.pathname);
  if (stops.length < 2)
    throw new Error("That link isn't directions. Get directions in Google Maps and share that link.");
  if (stops.some((stop) => !stop?.trim()))
    throw new Error(
      "These directions start from your location. Pick a start in Google Maps and share the link again.",
    );
  const pinned = [...link.matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  return stops.map((stop, i) => {
    const name = stop.trim();
    const typed = name.match(COORDINATE);
    if (typed) return { name, point: [Number(typed[2]), Number(typed[1])] };
    return { name, point: pinned.length === stops.length ? pinned[i] : null };
  });
}

function pathStops(pathname) {
  const parts = pathname.split("/");
  const dir = parts.indexOf("dir");
  if (dir === -1) return [];
  const stops = [];
  for (const part of parts.slice(dir + 1)) {
    if (part.startsWith("@") || part.startsWith("data=")) break;
    stops.push(decodeURIComponent(part.replace(/\+/g, " ")));
  }
  while (stops.length && !stops.at(-1).trim()) stops.pop();
  return stops;
}

async function locate(stop) {
  if (stop.point) return stop.point;
  const [place] = await getJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(stop.name)}`,
  );
  await sleep(1100);
  if (!place) throw new Error(`Couldn't find ${stop.name} on the map`);
  return [Number(place.lon), Number(place.lat)];
}

function decodeShape(shape) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < shape.length) {
    const deltas = [0, 0].map(() => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = shape.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return result & 1 ? ~(result >> 1) : result >> 1;
    });
    lat += deltas[0];
    lng += deltas[1];
    points.push([lng / 1e6, lat / 1e6]);
  }
  return points;
}

async function valhalla(from, to) {
  const response = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [from, to].map(([lon, lat]) => ({ lon, lat })),
      costing: "auto",
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const found = await response.json().catch(() => null);
  if (found?.trip)
    return { seconds: found.trip.summary.time, coordinates: decodeShape(found.trip.legs[0].shape) };
  if (found?.error_code === 154) return null;
  throw new Error("There's no driving route between those places");
}

async function splitLeg(from, to) {
  const path = `${from.join(",")};${to.join(",")}`;
  const found = await getJson(
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${path}?overview=full&geometries=geojson`,
  );
  const coordinates = found.routes?.[0]?.geometry.coordinates;
  if (!coordinates) throw new Error("There's no driving route between those places");
  const ends = [coordinates[0]];
  let along = 0;
  for (let i = 1; i < coordinates.length; i++) {
    along += km(coordinates[i - 1], coordinates[i]);
    if (along >= MAX_LEG_KM) {
      ends.push(coordinates[i]);
      along = 0;
    }
  }
  ends.push(coordinates.at(-1));
  return Promise.all(ends.slice(1).map((end, i) => valhalla(ends[i], end)));
}

async function drive(points) {
  const legs = await Promise.all(
    points.slice(1).map(async (to, i) => {
      const direct = await valhalla(points[i], to);
      return direct ? [direct] : splitLeg(points[i], to);
    }),
  );
  const pieces = legs.flat();
  if (pieces.some((piece) => !piece)) throw new Error("There's no driving route between those places");
  return {
    seconds: pieces.reduce((sum, piece) => sum + piece.seconds, 0),
    coordinates: pieces.flatMap((piece) => piece.coordinates),
  };
}

const km = ([lng1, lat1], [lng2, lat2]) => {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(x, lat2 - lat1) * 111.32;
};

function sample({ seconds, coordinates }) {
  const along = [0];
  for (let i = 1; i < coordinates.length; i++)
    along.push(along[i - 1] + km(coordinates[i - 1], coordinates[i]));
  const total = along.at(-1) || 1;
  const spacing = Math.max(MIN_SAMPLE_KM, total / MAX_SAMPLES);
  const samples = [];
  let nextKm = 0;
  coordinates.forEach((point, i) => {
    if (along[i] < nextKm && i !== coordinates.length - 1) return;
    samples.push({ point, seconds: (seconds * along[i]) / total });
    nextKm = along[i] + spacing;
  });
  return samples;
}

async function wikidata(query, retry = true) {
  const found = await getJson("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
    },
    body: new URLSearchParams({ query }),
  }).catch((error) => {
    if (!retry) throw error;
    return null;
  });
  return found ? found.results.bindings : wikidata(query, false);
}

const entity = (binding) => binding.value.split("/").at(-1);

function secondsNear(samples, wkt) {
  const point = wkt.match(/-?\d+(?:\.\d+)?/g).map(Number);
  let best = samples[0];
  for (const s of samples) if (km(s.point, point) < km(best.point, point)) best = s;
  return best.seconds;
}

async function townsAlong(samples) {
  const centers = samples
    .map((s) => `"Point(${s.point[0].toFixed(4)} ${s.point[1].toFixed(4)})"^^geo:wktLiteral`)
    .join(" ");
  const rows = await wikidata(`SELECT DISTINCT ?place ?name ?pop ?coord WHERE {
    VALUES ?center { ${centers} }
    SERVICE wikibase:around {
      ?place wdt:P625 ?coord.
      bd:serviceParam wikibase:center ?center; wikibase:radius "${TOWN_RADIUS_KM}".
    }
    ?place wdt:P1082 ?pop. FILTER(?pop >= 1000)
    ?place wdt:P31/wdt:P279* wd:Q486972.
    MINUS { ?place wdt:P31/wdt:P279* wd:Q123705. }
    MINUS { VALUES ?area { wd:Q5951278 wd:Q1768043 wd:Q702492 wd:Q1907114 } ?place wdt:P31 ?area. }
    ?place rdfs:label ?name. FILTER(lang(?name) = "en")
  }`);
  const towns = new Map();
  for (const row of rows) {
    const id = entity(row.place);
    const population = Number(row.pop.value);
    if ((towns.get(id)?.population ?? -1) >= population) continue;
    towns.set(id, {
      id,
      name: row.name.value,
      population,
      seconds: secondsNear(samples, row.coord.value),
    });
  }
  return [...towns.values()];
}

const NOT_THE_SONG =
  /\b(live at|live in|live from|remix|mix|karaoke|instrumental|demo|feat\.|featuring|programme|episode|chapter|podcast)\b|:|\d{4}-\d{2}-\d{2}/i;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const creditOf = (credits) => credits.map((c) => `${c.name}${c.joinphrase ?? ""}`).join("");

async function searchRecordings(town) {
  const query = encodeURIComponent(`recording:"${town.name}" AND video:false`);
  const search = () =>
    getJson(`https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=100`);
  const found = await search()
    .catch(() => sleep(1100).then(search))
    .catch(() => null);
  const name = new RegExp(`\\b${escape(plain(town.name.replace(/^The /, "")))}\\b`);
  return (found?.recordings ?? [])
    .filter((recording) => {
      const core = plain(recording.title.replace(/\(.*?\)|\[.*?\]|\s-\s.*$/g, ""));
      const mentioned = name.test(core) || (core === core.toUpperCase() && name.test(titleCase(core)));
      return recording.length && mentioned && !NOT_THE_SONG.test(recording.title);
    })
    .map((recording) => ({
      mbid: recording.id,
      title: recording.title,
      artist: creditOf(recording["artist-credit"] ?? []),
      durationMs: recording.length,
      seconds: town.seconds,
      town: town.id,
      named: true,
    }));
}

async function songsNamedAfter(towns, deadline) {
  const biggest = [...towns].sort((a, b) => b.population - a.population);
  const songs = [];
  for (const town of biggest.slice(0, MAX_TOWN_SEARCHES)) {
    if (Date.now() > deadline) break;
    const started = Date.now();
    songs.push(...(await searchRecordings(town)));
    await sleep(Math.max(0, 1100 - (Date.now() - started)));
  }
  const listens = new Map();
  for (const part of chunks(
    songs.map((s) => s.mbid),
    400,
  )) {
    const counts = await postJson("https://api.listenbrainz.org/1/popularity/recording", {
      recording_mbids: part,
    }).catch(() => []);
    for (const c of counts)
      if (c.total_listen_count) listens.set(c.recording_mbid, c.total_listen_count);
  }
  const best = new Map();
  for (const song of songs) {
    const count = listens.get(song.mbid);
    if (count && (best.get(songKey(song))?.listens ?? 0) < count)
      best.set(songKey(song), { ...song, listens: count });
  }
  const perTown = new Map();
  return [...best.values()]
    .sort((a, b) => b.listens - a.listens)
    .filter((song) => {
      const taken = perTown.get(song.town) ?? 0;
      perTown.set(song.town, taken + 1);
      return taken < SONGS_PER_TOWN;
    });
}

async function localArtists(towns, driveSeconds, deadline) {
  const secondsAt = new Map(towns.map((town) => [town.id, town.seconds]));
  const rows = await wikidata(`SELECT DISTINCT ?artist ?mbid ?place WHERE {
    VALUES ?place { ${towns.map((town) => `wd:${town.id}`).join(" ")} }
    ?artist wdt:P740|wdt:P19 ?place; wdt:P434 ?mbid.
  } LIMIT 20000`);
  const artists = new Map();
  for (const row of rows) {
    const seconds = secondsAt.get(entity(row.place));
    if ((artists.get(row.mbid.value)?.seconds ?? Infinity) > seconds)
      artists.set(row.mbid.value, { id: entity(row.artist), seconds });
  }
  const counts = await mapLimit(chunks([...artists.keys()], 400), 3, deadline, (part) =>
    postJson("https://api.listenbrainz.org/1/popularity/artist", { artist_mbids: part }),
  );
  const ranked = counts
    .filter((c) => c.total_listen_count && artists.has(c.artist_mbid))
    .map((c) => ({ ...artists.get(c.artist_mbid), listens: c.total_listen_count }))
    .sort((a, b) => b.listens - a.listens);
  const slots = new Map();
  for (const artist of ranked) {
    const slot = Math.floor(artist.seconds / SLOT_SECONDS);
    slots.set(slot, [...(slots.get(slot) ?? []), artist]);
  }
  const wanted = Math.min(ranked.length, Math.ceil((driveSeconds / AVERAGE_SONG_SECONDS / 4) * 1.5));
  const picked = [];
  for (let round = 0; picked.length < wanted; round++)
    for (const artists of slots.values()) if (artists[round]) picked.push(artists[round]);
  const labels = await wikidata(`SELECT ?artist ?name WHERE {
    VALUES ?artist { ${picked.map((artist) => `wd:${artist.id}`).join(" ")} }
    ?artist rdfs:label ?name. FILTER(lang(?name) = "en")
  }`);
  const names = new Map(labels.map((row) => [entity(row.artist), row.name.value]));
  const named = picked.slice(0, wanted).flatMap((artist) => {
    const name = names.get(artist.id);
    return name ? [{ ...artist, name }] : [];
  });
  return mapLimit(named, 2, deadline, topTracks);
}

async function deezer(path, retry = true) {
  const found = await getJson(`https://api.deezer.com${path}`);
  await sleep(250);
  if (found.error?.code === 4 && retry) {
    await sleep(5000);
    return deezer(path, false);
  }
  if (found.error) throw new Error(`Deezer: ${found.error.message}`);
  return found;
}

async function topTracks(artist) {
  const found = await deezer(
    `/search/artist?q=${encodeURIComponent(`artist:"${artist.name}"`)}&limit=5`,
  );
  const match = found.data
    ?.filter((a) => words(a.name) === words(artist.name))
    .sort((a, b) => b.nb_fan - a.nb_fan)[0];
  if (!match) return [];
  const top = await deezer(`/artist/${match.id}/top?limit=${TRACKS_PER_ARTIST}`);
  return (top.data ?? [])
    .filter((track) => track.artist?.id === match.id && track.duration)
    .map((track, rank) => ({
      title: track.title,
      artist: match.name,
      durationMs: track.duration * 1000,
      seconds: artist.seconds,
      listens: artist.listens / (rank + 1),
      named: false,
    }));
}

function schedule(candidates, driveSeconds) {
  const used = new Set();
  const plays = new Map();
  const playlist = [];
  let cursor = 0;
  while (driveSeconds - cursor > 90) {
    const remaining = driveSeconds - cursor;
    let best = null;
    let bestCost = Infinity;
    for (const song of candidates) {
      if (used.has(songKey(song))) continue;
      const length = song.durationMs / 1000;
      const offRoute =
        song.seconds < cursor ? cursor - song.seconds : Math.max(0, song.seconds - cursor - length);
      const cost =
        offRoute +
        (song.named ? -900 : 0) +
        (plays.get(song.artist) ?? 0) * 1200 -
        Math.log10(song.listens + 1) * 30 +
        (remaining < 600 ? Math.abs(remaining - length) * 3 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = song;
      }
    }
    if (!best) break;
    used.add(songKey(best));
    plays.set(best.artist, (plays.get(best.artist) ?? 0) + 1);
    playlist.push(best);
    cursor += best.durationMs / 1000;
  }
  return playlist;
}

const clock = (seconds) => {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const shortName = (stop) =>
  stop.name
    .split(",")
    .map((part) => part.trim())
    .find((part) => part && !/^\d/.test(part)) ?? stop.name;

async function plan(link) {
  const deadline = Date.now() + BUDGET_MS;
  const stops = parseDirections(await resolveLink(link));
  const points = [];
  for (const stop of stops) points.push(await locate(stop));
  const route = await drive(points);
  const towns = await townsAlong(sample(route));
  const [named, locals] = await Promise.all([
    songsNamedAfter(towns, deadline),
    localArtists(towns, route.seconds, deadline).catch((error) => {
      console.warn(`Skipped local artists: ${error.message}`);
      return [];
    }),
  ]);
  const playlist = schedule([...named, ...locals], route.seconds);
  if (!playlist.length) throw new Error("Couldn't find any music along that route");
  const minutes = playlist.reduce((sum, song) => sum + song.durationMs, 0) / 60_000;
  console.log(
    `${clock(route.seconds)} drive past ${towns.length} towns: ${named.length} songs named after them, ${locals.length} by local artists, ${playlist.length} picked for ${Math.round(minutes)}m`,
  );
  return {
    complete: minutes * 60 >= route.seconds * 0.9,
    name: `${shortName(stops[0])} to ${shortName(stops.at(-1))} · ${clock(route.seconds)}`,
    tracks: playlist.map(({ artist, title, durationMs, mbid }) => ({
      artist,
      title,
      durationMs,
      mbid: mbid ?? null,
    })),
  };
}

export default {
  importList: {
    async fetch({ url, dataFolder }) {
      const folder = join(dataFolder, "trips");
      const key = createHash("sha256").update(`${CACHE_VERSION}:${url}`).digest("hex");
      const file = join(folder, `${key.slice(0, 24)}.json`);
      const saved = await readFile(file, "utf8").catch(() => null);
      if (saved) return JSON.parse(saved);
      const { complete, ...trip } = await plan(url);
      if (complete) {
        await mkdir(folder, { recursive: true });
        await writeFile(file, JSON.stringify(trip));
      }
      return trip;
    },
  },
};
