import {
  baseName,
  type FilesFilter,
  filterLabel,
  validateFilesFilter,
  validName,
  validPath,
} from "./storage-model.ts";

/** Read-only Files view actions and the host-reviewed file operations. Paths are volume-relative. */
export type FilesIdentity = string;

export type FilesAgentOperation =
  | ({ type: "files_filter" } & FilesFilter)
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
export const FILES_CAPABILITY = "files.browser.v1";
export const FILES_OPERATION_TYPES: readonly string[] = [
  "files_filter",
  "files_open",
  "files_share",
  "files_move",
  "files_trash",
  "files_folder_create",
];
/** Read-only or view-only: they change nothing, so they need no separate review. */
export const FILES_DIRECT_TYPES: readonly string[] = [
  "files_filter",
  "files_open",
];
export const FILES_PATHS_MAX = 50;

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid files operation");
  return value as Bag;
};
export function isFilesOperation(value: unknown): value is FilesAgentOperation {
  return (
    !!value &&
    typeof value === "object" &&
    FILES_OPERATION_TYPES.includes(String((value as Bag).type))
  );
}
function agentPath(value: unknown, allowRoot = false): string {
  if (typeof value === "string" && value.startsWith("/"))
    throw Error("Invalid path");
  return validPath(value, allowRoot);
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > FILES_PATHS_MAX)
    throw Error("Select 1–50 files");
  const out = value.map((item) => agentPath(item));
  if (new Set(out).size !== out.length) throw Error("Duplicate files");
  return out;
}
function reviewedIdentities(value: unknown, count: number): FilesIdentity[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some(
      (token) =>
        typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token),
    )
  )
    throw Error("Invalid reviewed files");
  return value.slice();
}
export function validateFilesOperation(value: unknown): FilesAgentOperation {
  const op = bag(value);
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(op))
      if (!keys.includes(key)) throw Error("Unexpected files operation field");
  };
  switch (op.type) {
    case "files_filter": {
      allowed(["type", "text", "kind", "folder", "from", "to"]);
      const { type: _type, ...filter } = op;
      if (filter.folder !== undefined) agentPath(filter.folder, true);
      return { type: "files_filter", ...validateFilesFilter(filter) };
    }
    case "files_open":
      allowed(["type", "path"]);
      return { type: "files_open", path: agentPath(op.path) };
    case "files_share":
      allowed(["type", "paths"]);
      return { type: "files_share", paths: paths(op.paths) };
    case "files_trash": {
      allowed(["type", "paths", "reviewed"]);
      const selected = paths(op.paths);
      return {
        type: "files_trash",
        paths: selected,
        ...(op.reviewed === undefined
          ? {}
          : { reviewed: reviewedIdentities(op.reviewed, selected.length) }),
      };
    }
    case "files_move": {
      allowed(["type", "paths", "dest", "reviewed"]);
      const selected = paths(op.paths);
      return {
        type: "files_move",
        paths: selected,
        dest: agentPath(op.dest, true),
        ...(op.reviewed === undefined
          ? {}
          : { reviewed: reviewedIdentities(op.reviewed, selected.length) }),
      };
    }
    case "files_folder_create": {
      allowed(["type", "parent", "name"]);
      const name = validName(op.name);
      if (name.startsWith(".")) throw Error("Invalid name");
      return {
        type: "files_folder_create",
        parent: agentPath(op.parent, true),
        name,
      };
    }
  }
  throw Error("Unsupported files operation");
}
/** The filter fields of a files_filter operation. */
export function filesFilterOf(
  op: { type: "files_filter" } & FilesFilter,
): FilesFilter {
  const { type: _type, ...filter } = op;
  return filter;
}
const place = (path: string) =>
  path ? path.split("/").join(" › ") : "Internal storage";
const listed = (list: string[]) =>
  list.length <= 3
    ? list.map(baseName).join(", ")
    : `${list.slice(0, 2).map(baseName).join(", ")} and ${list.length - 2} more`;
const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);
/** Owner-facing title and the exact effect of a proposal. */
export function describeFilesOperation(op: FilesAgentOperation): {
  title: string;
  description: string;
} {
  switch (op.type) {
    case "files_filter":
      return {
        title: "Show files",
        description: filterLabel(filesFilterOf(op)),
      };
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
        description: place(op.parent ? op.parent + "/" + op.name : op.name),
      };
  }
}
/** Files tools are reviewed where the owner sees Files on the unlocked phone; the filter and
 * open tools may start from any unlocked screen and bring Files forward. */
export function filesContextAllowed(
  op: FilesAgentOperation,
  context: { view: string; sensitive?: boolean },
): boolean {
  if (context.sensitive) return false;
  return FILES_DIRECT_TYPES.includes(op.type) || context.view === "files";
}

/** The Files view registers the runner while it is installed (agent-adapter calls it). */
export type FilesAgentRunner = {
  reviewedIdentities(
    paths: string[],
    signal: AbortSignal,
  ): Promise<FilesIdentity[]>;
  run(
    op: FilesAgentOperation,
    signal: AbortSignal,
  ): Promise<{ status: "succeeded" | "failed"; summary: string }>;
};
