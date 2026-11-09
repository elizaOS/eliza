/**
 * Files browser device operations (`files.browser.v1`).
 *
 * The phone's Files view browses shared storage with all-files access. Paths
 * are relative to the primary storage volume ("Download/lease.pdf"); "" is the
 * volume root. A path is never absolute and never leaves the volume.
 *
 * - `files_filter` narrows what Files shows (a dismissible chip). It reads
 *   names, kinds, folders and dates only and changes nothing.
 * - `files_open` shows one file in Files. It changes nothing.
 * - `files_share`, `files_move`, `files_trash` and `files_folder_create` are
 *   proposals the owner reviews with Files on screen before anything changes or
 *   leaves the phone. A move keeps both files when the name is taken; trash is
 *   undoable from Files > Trash. A file that is no longer where the owner
 *   reviewed it is left alone.
 * - A move or trash carries `reviewed`: the opaque storage identity of
 *   each path as the phone read it when the proposal card was built. The agent
 *   never supplies it (the coordinator replaces whatever arrives), and the phone
 *   leaves any file whose identity has changed since then untouched.
 *
 * Operations keep one flat shape, so a validated operation validates again
 * unchanged (journal recovery re-reads it).
 */
import type { ActionParameterSchema } from "@elizaos/core/schema-types";

export const FILES_CAPABILITY = "files.browser.v1";
export const FILES_OPERATION_TYPES = [
  "files_filter",
  "files_open",
  "files_share",
  "files_move",
  "files_trash",
  "files_folder_create",
] as const;
/** View-only operations: they change nothing, so they run without a separate review. */
export const FILES_DIRECT_TYPES = ["files_filter", "files_open"] as const;
export const FILES_PATHS_MAX = 50;
export const FILES_FILTER_KINDS = [
  "image",
  "video",
  "audio",
  "document",
  "pdf",
  "folder",
] as const;

export type FilesFilterKind = (typeof FILES_FILTER_KINDS)[number];
export type FilesFilterOperation = {
  type: "files_filter";
  text?: string;
  kind?: FilesFilterKind;
  folder?: string;
  from?: string;
  to?: string;
};
/** Opaque identity of the storage object and revision shown in the review. */
export type FilesIdentity = string;
export type FilesAgentOperation =
  | FilesFilterOperation
  | { type: "files_open"; path: string }
  | { type: "files_share"; paths: string[] }
  | {
      type: "files_move";
      paths: string[];
      dest: string;
      reviewed?: FilesIdentity[];
    }
  | { type: "files_trash"; paths: string[]; reviewed?: FilesIdentity[] }
  | { type: "files_folder_create"; parent: string; name: string };

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid files operation");
  return value as Row;
}
function exact(value: Row, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Unexpected files operation field");
}
/** One file or folder name: no separators, no control characters, not "." or "..". */
export function validFilesName(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid name");
  const name = value.trim();
  if (
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: names exclude control characters
    /[/\\\u0000-\u001f\u007f]/.test(name)
  )
    throw Error("Invalid name");
  return name;
}
/** A volume-relative path; "" (the volume root) only where a folder is allowed. */
export function validFilesPath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || value.length > 1024 || value.startsWith("/"))
    throw Error("Invalid path");
  const path = value.replace(/\/+$/g, "");
  if (!path) {
    if (allowRoot) return "";
    throw Error("Invalid path");
  }
  for (const part of path.split("/"))
    if (validFilesName(part) !== part) throw Error("Invalid path");
  return path;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > FILES_PATHS_MAX)
    throw Error("Select 1-50 files");
  const out = value.map((item) => validFilesPath(item));
  if (new Set(out).size !== out.length) throw Error("Duplicate files");
  return out;
}
function identities(value: unknown, count: number): FilesIdentity[] {
  if (!Array.isArray(value) || value.length !== count)
    throw Error("Invalid reviewed files");
  return Array.from(value, (token: unknown) => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw Error("Invalid reviewed files");
    return token;
  });
}
/** Files operations that change files the owner reviewed by identity. */
export function filesNeedsIdentity(
  op: FilesAgentOperation,
): op is Extract<FilesAgentOperation, { type: "files_move" | "files_trash" }> {
  return op.type === "files_move" || op.type === "files_trash";
}
function isoDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d))?$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error("Invalid date");
  return value;
}

export function isFilesOperation(value: unknown): value is FilesAgentOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (FILES_OPERATION_TYPES as readonly string[]).includes(
      String((value as Row).type),
    )
  );
}
export function isFilesDirectType(type: string): boolean {
  return (FILES_DIRECT_TYPES as readonly string[]).includes(type);
}

export function validateFilesOperation(value: unknown): FilesAgentOperation {
  const op = row(value);
  switch (op.type) {
    case "files_filter": {
      exact(op, ["type", "text", "kind", "folder", "from", "to"]);
      const out: FilesFilterOperation = { type: "files_filter" };
      if (op.text !== undefined) {
        if (
          typeof op.text !== "string" ||
          !op.text.trim() ||
          op.text.length > 120 ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: filter text excludes control characters
          /[\u0000-\u001f]/.test(op.text)
        )
          throw Error("Invalid filter text");
        out.text = op.text.trim();
      }
      if (op.kind !== undefined) {
        if (
          !(FILES_FILTER_KINDS as readonly string[]).includes(String(op.kind))
        )
          throw Error("Invalid filter kind");
        out.kind = op.kind as FilesFilterKind;
      }
      if (op.folder !== undefined) out.folder = validFilesPath(op.folder, true);
      if (op.from !== undefined) out.from = isoDate(op.from);
      if (op.to !== undefined) out.to = isoDate(op.to);
      if (out.from && out.to && Date.parse(out.from) > Date.parse(out.to))
        throw Error("Invalid date range");
      if (Object.keys(out).length === 1) throw Error("Empty filter");
      return out;
    }
    case "files_open":
      exact(op, ["type", "path"]);
      return { type: "files_open", path: validFilesPath(op.path) };
    case "files_share":
      exact(op, ["type", "paths"]);
      return { type: "files_share", paths: paths(op.paths) };
    case "files_trash": {
      exact(op, ["type", "paths", "reviewed"]);
      const list = paths(op.paths);
      return {
        type: "files_trash",
        paths: list,
        ...(op.reviewed === undefined
          ? {}
          : { reviewed: identities(op.reviewed, list.length) }),
      };
    }
    case "files_move": {
      exact(op, ["type", "paths", "dest", "reviewed"]);
      const list = paths(op.paths);
      return {
        type: "files_move",
        paths: list,
        dest: validFilesPath(op.dest, true),
        ...(op.reviewed === undefined
          ? {}
          : { reviewed: identities(op.reviewed, list.length) }),
      };
    }
    case "files_folder_create": {
      exact(op, ["type", "parent", "name"]);
      const name = validFilesName(op.name);
      if (name.startsWith(".")) throw Error("Invalid name");
      return {
        type: "files_folder_create",
        parent: validFilesPath(op.parent, true),
        name,
      };
    }
  }
  throw Error("Unsupported files operation");
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const place = (path: string) =>
  path ? path.split("/").join(" › ") : "Internal storage";
const listed = (list: readonly string[]) =>
  list.length <= 3
    ? list.map(baseName).join(", ")
    : `${list.slice(0, 2).map(baseName).join(", ")} and ${list.length - 2} more`;
const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);
const KIND_LABELS: Record<FilesFilterKind, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  pdf: "PDFs",
  folder: "Folders",
};
/** The chip a filter shows, for example `“lease” · PDFs · in Download`. */
export function filesFilterLabel(
  op: Omit<FilesFilterOperation, "type">,
): string {
  return [
    op.text ? `“${op.text}”` : "",
    op.kind ? KIND_LABELS[op.kind] : "",
    op.folder !== undefined
      ? `in ${baseName(op.folder) || "Internal storage"}`
      : "",
    op.from || op.to
      ? [op.from?.slice(0, 10), op.to?.slice(0, 10)].filter(Boolean).join(" – ")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
/** Owner-facing title and the exact effect of a proposal. */
export function describeFilesOperation(op: FilesAgentOperation): {
  title: string;
  description: string;
} {
  switch (op.type) {
    case "files_filter":
      return { title: "Show files", description: filesFilterLabel(op) };
    case "files_open":
      return { title: "Open file", description: place(op.path) };
    case "files_share":
      return {
        title: `Share ${count(op.paths.length)}`,
        description: listed(op.paths),
      };
    case "files_trash":
      return {
        title: `Move ${count(op.paths.length)} to Trash`,
        description: listed(op.paths),
      };
    case "files_move":
      return {
        title: `Move ${count(op.paths.length)}`,
        description: `${listed(op.paths)} → ${place(op.dest)}`,
      };
    case "files_folder_create":
      return {
        title: "New folder",
        description: place(op.parent ? `${op.parent}/${op.name}` : op.name),
      };
  }
}
/** Changes are reviewed only where the owner sees Files on the unlocked phone;
 * filter and open may start from any unlocked screen and bring Files forward. */
export function filesContextAllowed(
  op: FilesAgentOperation,
  context: { view: string; sensitive?: boolean },
): boolean {
  if (context.sensitive) return false;
  return isFilesDirectType(op.type) || context.view === "files";
}

const filesPath = {
  type: "string",
  description: 'Path on Internal storage, for example "Download/lease.pdf"',
} as const;
const filesPaths = {
  type: "array",
  items: filesPath,
  description: "1-50 paths on Internal storage",
} as const;
/** Tool schema branches (one per operation, disjoint by `type`). */
export const FILES_OPERATION_SCHEMAS: ActionParameterSchema[] = [
  {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { type: "string", enum: ["files_filter"] },
      text: { type: "string", description: "Words in the file name" },
      kind: { type: "string", enum: [...FILES_FILTER_KINDS] },
      folder: {
        type: "string",
        description:
          'Folder path, for example "Download"; "" is Internal storage',
      },
      from: { type: "string", description: "Modified on or after, YYYY-MM-DD" },
      to: { type: "string", description: "Modified on or before, YYYY-MM-DD" },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["type", "path"],
    properties: {
      type: { type: "string", enum: ["files_open"] },
      path: filesPath,
    },
  },
  ...(["files_share", "files_trash"] as const).map((type) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "paths"],
    properties: { type: { type: "string", enum: [type] }, paths: filesPaths },
  })),
  {
    type: "object",
    additionalProperties: false,
    required: ["type", "paths", "dest"],
    properties: {
      type: { type: "string", enum: ["files_move"] },
      paths: filesPaths,
      dest: {
        ...filesPath,
        description: 'Destination folder; "" is Internal storage',
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["type", "parent", "name"],
    properties: {
      type: { type: "string", enum: ["files_folder_create"] },
      parent: {
        ...filesPath,
        description: 'Parent folder; "" is Internal storage',
      },
      name: { type: "string" },
    },
  },
];
export const FILES_GUIDANCE =
  "Phone Files (requires files.browser.v1): to find files, use files_filter with name words, a kind, a folder or a modified date range; it only narrows what Files shows and returns a count, never file contents. files_open shows one file. files_share, files_move, files_trash and files_folder_create are reviewed with Files on screen; a move never replaces a file with the same name, and Trash is restorable for 30 days. Use only paths the owner named or Files showed; never invent paths.";
