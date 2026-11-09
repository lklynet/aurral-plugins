const API = "https://api.setlist.fm/rest/1.0";
const USER_AGENT = "AurralSetlists/0.1 ( https://github.com/lklynet/aurral-plugins )";
const REQUEST_GAP_MS = 600;
const MAX_TOUR_PAGES = 10;
const MAX_ARTIST_PAGES = 3;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextSlot = 0;

async function waitTurn() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + REQUEST_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

const client = (apiKey) =>
  async function get(path, params = {}, attempt = 1) {
    await waitTurn();
    const url = new URL(API + path);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403)
      throw new Error("setlist.fm rejected the API key");
    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_MS * attempt);
      return get(path, params, attempt + 1);
    }
    if (response.status === 429)
      throw new Error("setlist.fm is limiting requests for this API key. Try again in a minute.");
    if (!response.ok) throw new Error(`setlist.fm answered ${response.status}`);
    return response.json();
  };

function parseLink(link) {
  const { pathname } = new URL(link);
  const show = /^\/setlist\/.+-([0-9a-f]+)\.html$/.exec(pathname);
  if (show) return { kind: "show", id: show[1] };
  const artist = /^\/setlists\/(.+)-([0-9a-f]+)\.html$/.exec(pathname);
  if (artist) return { kind: "artist", slug: artist[1], id: artist[2] };
  throw new Error("Paste a link to an artist's setlists or to one setlist on setlist.fm");
}

const songs = (setlist) =>
  (setlist.sets?.set ?? [])
    .flatMap((set) => set.song ?? [])
    .filter((song) => song.name?.trim() && !song.tape)
    .map((song) => ({
      artist: song.cover?.name ?? setlist.artist.name,
      title: song.name.trim(),
    }));

const songKey = (track) => `${track.artist}\n${track.title}`.toLowerCase();

const distinct = (tracks) => [...new Map(tracks.map((track) => [songKey(track), track])).values()];

function showPlaylist(setlist) {
  const [day, month, year] = setlist.eventDate.split("-");
  const place = [setlist.venue?.name, setlist.venue?.city?.name].filter(Boolean).join(", ");
  return {
    name: [setlist.artist.name, place, `${year}-${month}-${day}`].filter(Boolean).join(" · "),
    tracks: distinct(songs(setlist)),
  };
}

async function findArtist(get, slug, id) {
  const suffix = `-${id}.html`;
  for (let p = 1; p <= MAX_ARTIST_PAGES; p++) {
    const page = await get("/search/artists", {
      artistName: slug.replaceAll("-", " "),
      sort: "relevance",
      p,
    });
    const match = page?.artist.find((artist) => artist.url.endsWith(suffix));
    if (match) return match;
    if (!page || p * page.itemsPerPage >= page.total) break;
  }
  throw new Error("Couldn't find this artist through the setlist.fm API");
}

async function tourShows(get, artist, tour) {
  const shows = [];
  for (let p = 1; p <= MAX_TOUR_PAGES; p++) {
    const page = await get("/search/setlists", { artistMbid: artist.mbid, tourName: tour, p });
    if (!page) break;
    shows.push(...page.setlist);
    if (p * page.itemsPerPage >= page.total) break;
  }
  return shows;
}

async function tourPlaylist(get, artist) {
  const recent = await get(`/artist/${artist.mbid}/setlists`);
  const latest = recent?.setlist.find((setlist) => songs(setlist).length);
  if (!latest) throw new Error(`setlist.fm has no setlists with songs for ${artist.name}`);
  const shows = latest.tour
    ? await tourShows(get, artist, latest.tour.name)
    : recent.setlist.filter((setlist) => !setlist.tour);
  const plays = new Map();
  for (const show of shows) {
    for (const track of distinct(songs(show))) {
      const entry = plays.get(songKey(track)) ?? { track, count: 0 };
      entry.count += 1;
      plays.set(songKey(track), entry);
    }
  }
  const rest = [...plays.values()].sort((a, b) => b.count - a.count).map((entry) => entry.track);
  return {
    name: `${artist.name} · ${latest.tour?.name ?? "Recent setlists"}`,
    tracks: distinct([...songs(latest), ...rest]),
  };
}

export default {
  async test({ settings }) {
    await client(settings.apiKey)("/search/artists", { artistName: "Radiohead" });
    return { message: "Connected to setlist.fm" };
  },
  importList: {
    async fetch({ url, settings }) {
      const get = client(settings.apiKey);
      const link = parseLink(url);
      if (link.kind === "show") {
        const setlist = await get(`/setlist/${link.id}`);
        if (!setlist) throw new Error("setlist.fm has no setlist at this link");
        return showPlaylist(setlist);
      }
      return tourPlaylist(get, await findArtist(get, link.slug, link.id));
    },
  },
};
