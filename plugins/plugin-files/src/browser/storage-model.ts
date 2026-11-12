/**
 * Files browser rules shared by the renderer, the browser storage volume and the agent
 * contract (design/view-refresh-2026-11/PLAN.md section 4; checked model
 * artifacts/review-2026-11/specs/files-browser). Paths are relative to one storage volume
 * ("Download/a.pdf"); the volume root is "". Android mirrors the same naming rule in
 * StorageBrowser.freeName.
 */
export type StorageEntry = {
  path: string;
  name: string;
  directory: boolean;
  mimeType: string;
  size: number;
  modified: number;
  /** Child count for folders when the backend knows it cheaply. */
  children?: number;
};
export type TrashEntry = {
  id: string;
  name: string;
  origin: string;
  directory: boolean;
  mimeType: string;
  size: number;
  deletedAt: number;
};
export type StorageVolume = {
  id: string;
  name: string;
  primary: boolean;
  free: number;
  total: number;
  usage?: { bytes: number; files: number };
};
export type FilesCategory =
  | "downloads"
  | "images"
  | "videos"
  | "audio"
  | "documents";
export type SortMode = "name" | "date" | "size";

export const TRASH_RETENTION_DAYS = 30;
const DAY = 86400000;
/** The Downloads entry is the Download folder itself, never a query over other folders. */
export const DOWNLOAD_FOLDER = "Download";
export const CATEGORIES: readonly { id: FilesCategory; label: string }[] = [
  { id: "downloads", label: "Downloads" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Documents" },
];
/** PDF, office and text documents anywhere in shared storage. */
export const DOCUMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/rtf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
];

const EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  amr: "audio/amr",
  zip: "application/zip",
  apk: "application/vnd.android.package-archive",
};
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? (EXTENSIONS[name.slice(dot + 1).toLowerCase()] ??
        "application/octet-stream")
    : "application/octet-stream";
}

/** What each Browse category lists (spec CategoryIsQuery). Downloads is the folder, by path. */
export function inCategory(
  category: FilesCategory,
  entry: Pick<StorageEntry, "path" | "directory" | "mimeType">,
): boolean {
  if (entry.directory) return false;
  if (category === "downloads") return parentOf(entry.path) === DOWNLOAD_FOLDER;
  if (category === "images") return entry.mimeType.startsWith("image/");
  if (category === "videos") return entry.mimeType.startsWith("video/");
  if (category === "audio") return entry.mimeType.startsWith("audio/");
  return DOCUMENT_MIME_TYPES.includes(entry.mimeType);
}
/** A category's files counted per folder (Android counts every file, not only the listed ones). */
export type CategoryFolder = {
  folder: string;
  count: number;
  latest: StorageEntry;
};
/**
 * Images and Videos are shown grouped by the folder that holds them (Camera, Screenshots, …).
 * `counted` (the storage's own per-folder counts over the whole category) wins over grouping
 * `entries`, which may be a bounded newest-first part of it.
 */
export function groupByFolder(
  entries: readonly StorageEntry[],
  counted?: readonly CategoryFolder[],
): { folder: string; name: string; count: number; latest: StorageEntry }[] {
  const groups = new Map<string, { count: number; latest: StorageEntry }>();
  if (counted)
    for (const group of counted)
      groups.set(group.folder, { count: group.count, latest: group.latest });
  else
    for (const entry of entries) {
      const key = parentOf(entry.path),
        group = groups.get(key);
      if (!group) groups.set(key, { count: 1, latest: entry });
      else {
        group.count++;
        if (entry.modified > group.latest.modified) group.latest = entry;
      }
    }
  return [...groups]
    .map(([folder, { count, latest }]) => ({
      folder,
      name: folder
        ? folder.slice(folder.lastIndexOf("/") + 1)
        : "Internal storage",
      count,
      latest,
    }))
    .sort(
      (a, b) =>
        b.latest.modified - a.latest.modified ||
        a.folder.localeCompare(b.folder),
    );
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
export function joinPath(folder: string, name: string): string {
  return folder ? folder + "/" + name : name;
}
/** A path is inside (or equal to) a folder. */
export function within(path: string, folder: string): boolean {
  return !folder || path === folder || path.startsWith(folder + "/");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject separators and control characters in file names.
const INVALID_NAME_CHARACTER = /[/\\\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in filter text.
const FILTER_CONTROL_CHARACTER = /[\u0000-\u001f]/;

/** One file or folder name: no separators, no control characters, not "." or "..". */
export function validName(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid name");
  const name = value.trim();
  if (
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    INVALID_NAME_CHARACTER.test(name)
  )
    throw Error("Invalid name");
  return name;
}
/** A volume-relative path; "" is the volume root. Never absolute, never escaping the volume. */
export function validPath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || value.length > 1024)
    throw Error("Invalid path");
  const path = value.replace(/^\/+|\/+$/g, "");
  if (!path) {
    if (allowRoot) return "";
    throw Error("Invalid path");
  }
  return path
    .split("/")
    .map((part) =>
      validName(part) === part
        ? part
        : (() => {
            throw Error("Invalid path");
          })(),
    )
    .join("/");
}

/** Spec FreeName: a clash keeps both, as "name (1).ext", "name (2).ext", … Never replaces. */
export function freeName(
  name: string,
  taken: ReadonlySet<string> | readonly string[],
  directory = false,
): string {
  const used = new Set([...taken].map((value) => value.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = directory ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  const base = stem.replace(/ \(\d+\)$/, "");
  for (let n = 1; n < 10000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw Error("No free name");
}

/** Folders first, then the chosen order. Date and size are newest/largest first. */
export function sortEntries<
  T extends Pick<StorageEntry, "name" | "directory" | "modified" | "size">,
>(entries: readonly T[], mode: SortMode, reverse = false): T[] {
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  return [...entries].sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) ||
      (reverse ? -1 : 1) *
        (a.directory && b.directory
          ? byName(a, b)
          : mode === "date"
            ? b.modified - a.modified || byName(a, b)
            : mode === "size"
              ? b.size - a.size || byName(a, b)
              : byName(a, b)),
  );
}
export const SORT_LABELS: Record<SortMode, string> = {
  name: "Name",
  date: "Date",
  size: "Size",
};

export function breadcrumbs(
  path: string,
  rootLabel = "Internal storage",
): { label: string; path: string }[] {
  const parts = path ? path.split("/") : [];
  return [
    { label: rootLabel, path: "" },
    ...parts.map((label, index) => ({
      label,
      path: parts.slice(0, index + 1).join("/"),
    })),
  ];
}

export function trashDaysLeft(deletedAt: number, now: number): number {
  return Math.max(
    0,
    Math.ceil((deletedAt + TRASH_RETENTION_DAYS * DAY - now) / DAY),
  );
}
export function trashExpired(deletedAt: number, now: number): boolean {
  return now >= deletedAt + TRASH_RETENTION_DAYS * DAY;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return (
    (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) +
    " " +
    units[unit]
  );
}
export function formatFree(
  volume: Pick<StorageVolume, "free" | "total" | "usage">,
): string {
  if (volume.total > 0)
    return `${formatSize(volume.free)} free of ${formatSize(volume.total)}`;
  const usage = volume.usage;
  if (!usage) return "";
  return `${formatSize(usage.bytes)} in ${usage.files} app ${usage.files === 1 ? "file" : "files"}`;
}

/** The agent's read-only filter. It only narrows what the view shows (spec FilterIsReadOnly). */
export type FilesFilter = {
  text?: string;
  kind?: "image" | "video" | "audio" | "document" | "pdf" | "folder";
  folder?: string;
  from?: string;
  to?: string;
};
const FILTER_KINDS = new Set([
  "image",
  "video",
  "audio",
  "document",
  "pdf",
  "folder",
]);
const isoDate = (value: unknown) => {
  if (typeof value !== "string" || value.length > 40)
    throw Error("Invalid date");
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    !/^\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d))?$/.test(value)
  )
    throw Error("Invalid date");
  return value;
};
export function validateFilesFilter(value: unknown): FilesFilter {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid filter");
  const row = value as Record<string, unknown>,
    out: FilesFilter = {};
  if (
    Object.keys(row).some(
      (key) => !["text", "kind", "folder", "from", "to"].includes(key),
    )
  )
    throw Error("Unexpected filter fields");
  if (row.text !== undefined) {
    if (
      typeof row.text !== "string" ||
      !row.text.trim() ||
      row.text.length > 120 ||
      FILTER_CONTROL_CHARACTER.test(row.text)
    )
      throw Error("Invalid filter text");
    out.text = row.text.trim();
  }
  if (row.kind !== undefined) {
    if (!FILTER_KINDS.has(String(row.kind))) throw Error("Invalid filter kind");
    out.kind = row.kind as FilesFilter["kind"];
  }
  if (row.folder !== undefined) out.folder = validPath(row.folder, true);
  if (row.from !== undefined) out.from = isoDate(row.from);
  if (row.to !== undefined) out.to = isoDate(row.to);
  if (out.from && out.to && Date.parse(out.from) > Date.parse(out.to))
    throw Error("Invalid date range");
  if (!Object.keys(out).length) throw Error("Empty filter");
  return out;
}
/**
 * The instant a filter date bounds. A date without a time is that day on this device, from its
 * first millisecond (`from`) to its last (`to`); a date with a time and zone is that instant.
 */
export function filterTime(value: string, end = false): number {
  if (value.length !== 10) return Date.parse(value);
  const [year, month, day] = value.split("-").map(Number);
  return end
    ? new Date(year, month - 1, day + 1).getTime() - 1
    : new Date(year, month - 1, day).getTime();
}
// Words of any script, like StorageCatalog.query on Android.
const words = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
/** Scripts that do not space their words: a filter word may sit inside a name word. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export function filterMatches(
  filter: FilesFilter,
  entry: StorageEntry,
): boolean {
  if (filter.kind) {
    if (filter.kind === "folder" ? !entry.directory : entry.directory)
      return false;
    if (filter.kind === "image" && !entry.mimeType.startsWith("image/"))
      return false;
    if (filter.kind === "video" && !entry.mimeType.startsWith("video/"))
      return false;
    if (filter.kind === "audio" && !entry.mimeType.startsWith("audio/"))
      return false;
    if (filter.kind === "pdf" && entry.mimeType !== "application/pdf")
      return false;
    if (
      filter.kind === "document" &&
      !DOCUMENT_MIME_TYPES.includes(entry.mimeType)
    )
      return false;
  }
  if (
    filter.folder !== undefined &&
    !within(parentOf(entry.path), filter.folder)
  )
    return false;
  if (filter.from && entry.modified < filterTime(filter.from)) return false;
  if (filter.to && entry.modified > filterTime(filter.to, true)) return false;
  if (filter.text) {
    const name = words(entry.name);
    if (
      !words(filter.text).every((word) =>
        name.some((part) =>
          UNSPACED_SCRIPT.test(word)
            ? part.includes(word)
            : part.startsWith(word),
        ),
      )
    )
      return false;
  }
  return true;
}
export function filterLabel(filter: FilesFilter): string {
  const kind = filter.kind
    ? {
        image: "Images",
        video: "Videos",
        audio: "Audio",
        document: "Documents",
        pdf: "PDFs",
        folder: "Folders",
      }[filter.kind]
    : "";
  const parts = [
    filter.text ? `“${filter.text}”` : "",
    kind,
    filter.folder
      ? "in " + (baseName(filter.folder) || "Internal storage")
      : "",
    filter.from || filter.to
      ? [filter.from?.slice(0, 10), filter.to?.slice(0, 10)]
          .filter(Boolean)
          .join(" – ")
      : "",
  ];
  return parts.filter(Boolean).join(" · ");
}
