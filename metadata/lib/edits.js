// Each edit changes an open file in memory and returns whether it changed anything. None changes a
// value Aurral reads back: a full date keeps its year, and totals keep its track and disc numbers.
import {
  ByteVector,
  Id3v2FrameClassType,
  isCover,
  MAX_PICTURE_BYTES,
  Picture,
  PictureType,
  readDate,
  readGain,
  readText,
  asStored,
  StringType,
  TagTypes,
  TEXT_FIELDS,
  tagsOf,
  writeDate,
  writeText,
} from "./tags.js";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const list = (value) =>
  (Array.isArray(value) ? value : [value]).filter(
    (entry) => entry !== null && entry !== undefined && entry !== "",
  );

const JUNK =
  /https?:\/\/|www\.|\b(downloaded|ripped|uploaded|encoded|converted)\s+(from|by|with|at|on)\b|\btorrent\b|amazon\.com song id|\bfree\s+(mp3|download)\b/i;
const isAurralMarker = (text) => String(text).trim().startsWith("AURRAL_IDS");
const isJunk = (text) => !isAurralMarker(text) && (!String(text ?? "").trim() || JUNK.test(text));

const XIPH_DROP = [
  "PURL",
  "SYNOPSIS",
  "ENCODER",
  "ENCODED-BY",
  "ENCODEDBY",
  "ENCODED_BY",
  "ENCODERSETTINGS",
  "ENCODING",
];
const XIPH_DROP_IF_JUNK = ["COMMENT", "COMMENTS", "DESCRIPTION"];
const ID3_DROP = new Set([
  "TENC",
  "TSSE",
  "WOAF",
  "WOAS",
  "WCOM",
  "WPAY",
  "WPUB",
  "WORS",
  "WXXX",
  "PRIV",
  "OWNE",
  "COMR",
]);
const TXXX_DROP = new Set(["purl", "synopsis", "encoder", "encoded by", "encodedby", "encoding"]);
const TXXX_DROP_IF_JUNK = new Set(["comment", "description"]);
const APPLE_DROP = ["©too", "purl", "desc", "ldes", "apID", "ownr", "purd"].map((name) =>
  ByteVector.fromString(name, StringType.Latin1),
);
const APPLE_COMMENT = ByteVector.fromString("©cmt", StringType.Latin1);

function cleanXiph(xiph) {
  let changed = false;
  for (const key of XIPH_DROP) {
    if (xiph.getField(key).length) {
      xiph.removeField(key);
      changed = true;
    }
  }
  for (const key of XIPH_DROP_IF_JUNK) {
    const values = xiph.getField(key);
    const kept = values.filter((value) => !isJunk(value));
    if (kept.length !== values.length) {
      xiph.setFieldAsStrings(key, ...kept);
      changed = true;
    }
  }
  return changed;
}

function cleanId3(id3) {
  let changed = false;
  for (const frame of [...id3.frames]) {
    const id = frame.frameId?.toString();
    let drop = ID3_DROP.has(id);
    if (frame.frameClassType === Id3v2FrameClassType.UserTextInformationFrame) {
      const description = frame.description.toLowerCase();
      drop =
        TXXX_DROP.has(description) ||
        (TXXX_DROP_IF_JUNK.has(description) && (frame.text ?? []).every(isJunk));
    }
    // iTunNORM, iTunSMPB and the like hold loudness and gapless data.
    if (frame.frameClassType === Id3v2FrameClassType.CommentsFrame)
      drop = !/^itun/i.test(frame.description ?? "") && isJunk(frame.text);
    if (drop) {
      id3.removeFrame(frame);
      changed = true;
    }
  }
  if (id3.version < 4) {
    id3.version = 4;
    changed = true;
  }
  return changed;
}

function cleanApple(apple) {
  let changed = false;
  for (const box of APPLE_DROP) {
    if (apple.getQuickTimeData(box).length) {
      apple.setQuickTimeData(box, undefined);
      changed = true;
    }
  }
  const comment = apple.getFirstQuickTimeString(APPLE_COMMENT);
  if (comment !== undefined && isJunk(comment)) {
    apple.setQuickTimeData(APPLE_COMMENT, undefined);
    changed = true;
  }
  return changed;
}

// Keeps one cover and drops the other pictures, such as disc scans and
// booklets. An oversized cover goes too when the plugin will embed a new one.
function cleanPictures(file, hasNewCover) {
  const pictures = file.tag.pictures ?? [];
  const cover =
    pictures.find((picture) => picture.type === PictureType.FrontCover) ?? pictures.find(isCover);
  const keep = cover && !(hasNewCover && cover.data.length > MAX_PICTURE_BYTES) ? [cover] : [];
  if (keep.length === pictures.length) return false;
  file.tag.pictures = keep;
  return true;
}

export function clean(file, kind, hasNewCover) {
  let changed = false;
  const tags = tagsOf(file, kind);
  // Leftover tag types players read before the real one: ID3v1 and APE on an
  // MP3, and any ID3 or APE tag on a FLAC or Ogg file.
  const stray =
    kind === "mp3" && tags.id3?.title
      ? TagTypes.Id3v1 | TagTypes.Ape
      : kind === "xiph" && tags.xiph
        ? TagTypes.Id3v1 | TagTypes.Id3v2 | TagTypes.Ape
        : TagTypes.None;
  const present = file.tagTypesOnDisk & stray;
  if (present) {
    file.removeTags(present);
    changed = true;
  }
  const kept = tagsOf(file, kind);
  if (kept.xiph && cleanXiph(kept.xiph)) changed = true;
  if (kept.id3 && cleanId3(kept.id3)) changed = true;
  if (kept.apple && cleanApple(kept.apple)) changed = true;
  if (cleanPictures(file, hasNewCover)) changed = true;
  return changed;
}

// Fields another tagger left beside the real ones, like Tidal's, which Navidrome reads first.
const LEFTOVERS = {
  TRACKNUMBER: ["TRACK"],
  DISCNUMBER: ["DISC"],
  TRACKTOTAL: ["TRACKC", "TOTALTRACKS"],
  DISCTOTAL: ["DISCC", "TOTALDISCS"],
  ALBUMARTIST: ["ALBUM ARTIST", "ALBUM_ARTIST"],
};

// Reads "4" and "04/11" as the same track number.
function agrees(left, right) {
  const number = (text) => /^\s*0*(\d+)\s*(\/|$)/.exec(text)?.[1];
  const [a, b] = [number(left), number(right)];
  return a && b ? a === b : left === right;
}

// Drops a leftover field only when it disagrees with the real one. It runs after the release
// details, so it sees the totals they add.
export function dropLeftovers(file, kind) {
  const { xiph } = tagsOf(file, kind);
  if (!xiph) return false;
  let changed = false;
  for (const [field, leftovers] of Object.entries(LEFTOVERS)) {
    const real = xiph.getField(field).join("; ");
    if (!real) continue;
    for (const leftover of leftovers) {
      const values = xiph.getField(leftover);
      if (!values.length || agrees(values.join("; "), real)) continue;
      xiph.removeField(leftover);
      changed = true;
    }
  }
  return changed;
}

export function embedCover(file, cover, replace) {
  const pictures = file.tag.pictures ?? [];
  const current = pictures.filter(isCover);
  if (current.length && !replace) return false;
  if (
    current.length === 1 &&
    current[0].type === PictureType.FrontCover &&
    Buffer.from(current[0].data.toByteArray()).equals(cover.data)
  )
    return false;
  const picture = Picture.fromFullData(
    ByteVector.fromByteArray(cover.data),
    PictureType.FrontCover,
    cover.mimeType,
    "",
  );
  file.tag.pictures = [picture, ...pictures.filter((entry) => !isCover(entry))];
  return true;
}

export function addDetails(file, kind, details, replace) {
  const tags = tagsOf(file, kind, true);
  let changed = false;

  for (const [key, spec] of Object.entries(TEXT_FIELDS)) {
    const values = list(details[key]).map(String);
    if (!values.length) continue;
    const wanted = asStored(tags, spec, values);
    const current = readText(tags, spec);
    if (same(current, wanted) || (current.length && !replace)) continue;
    writeText(tags, spec, values);
    changed = true;
  }

  // A full date only adds precision to the year Aurral wrote. It never
  // contradicts it, because Aurral picks the year of the album it filed.
  const date = details.date;
  const year = file.tag.year;
  if (date && /^\d{4}/.test(date) && (!year || Number(date.slice(0, 4)) === year)) {
    const current = readDate(tags);
    if (current !== date && (!current || date.startsWith(current) || replace)) {
      writeDate(tags, date);
      // An ID3v2.3 tag keeps its year, so nothing may have changed.
      if (readDate(tags) !== current) changed = true;
    }
  }

  const { tag } = file;
  const fill = (current, wanted) =>
    wanted !== null && wanted !== undefined && !same(current, wanted) && (!current || replace);
  if (fill(tag.trackCount, details.trackCount) && tag.track) {
    tag.trackCount = details.trackCount;
    changed = true;
  }
  if (fill(tag.discCount, details.discCount) && tag.disc) {
    tag.discCount = details.discCount;
    changed = true;
  }
  // ID3v2.3 has no artist sort frame, and taglib drops TSOP when it saves one.
  const id3v23 = tags.id3 && !tags.xiph && !tags.apple && tags.id3.version < 4;
  if (!id3v23 && fill(tag.performersSort?.[0], details.artistSort)) {
    tag.performersSort = [details.artistSort];
    changed = true;
  }
  if (fill(tag.albumArtistsSort?.[0], details.albumArtistSort)) {
    tag.albumArtistsSort = [details.albumArtistSort];
    changed = true;
  }
  if (details.compilation && !tag.isCompilation) {
    tag.isCompilation = true;
    changed = true;
  }
  return changed;
}

export function embedLyrics(file, text, replace) {
  const current = file.tag.lyrics?.trim() || "";
  if (current === text.trim() || (current && !replace)) return false;
  file.tag.lyrics = text;
  return true;
}

const nearlyEqual = (left, right) => Number.isFinite(left) && Math.abs(left - right) < 0.01;

// Opus files get R128 gains, everything else ReplayGain 2.0. The album gain is null when some
// track of the album couldn't be measured.
export function addReplayGain(file, kind, replayGain, opus) {
  let changed = false;
  if (opus) {
    const xiph = tagsOf(file, kind, true).xiph;
    for (const [scope, value] of [
      ["track", replayGain.writeTrack ? replayGain.track : null],
      ["album", replayGain.album],
    ]) {
      if (!value || readGain(file, xiph, scope) === value.r128) continue;
      xiph.setFieldAsStrings(`R128_${scope.toUpperCase()}_GAIN`, String(value.r128));
      changed = true;
    }
    return changed;
  }
  const { tag } = file;
  if (replayGain.writeTrack && !nearlyEqual(tag.replayGainTrackGain, replayGain.track.gain)) {
    tag.replayGainTrackGain = replayGain.track.gain;
    tag.replayGainTrackPeak = replayGain.track.peak;
    changed = true;
  }
  if (replayGain.album && !nearlyEqual(tag.replayGainAlbumGain, replayGain.album.gain)) {
    tag.replayGainAlbumGain = replayGain.album.gain;
    tag.replayGainAlbumPeak = replayGain.album.peak;
    changed = true;
  }
  return changed;
}
