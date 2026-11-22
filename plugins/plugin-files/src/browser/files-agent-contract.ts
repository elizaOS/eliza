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
  /** The item at this position (1 is the first) in the filter results Files shows. */
  | { type: "files_open"; shown: number }
  | { type: "files_share"; paths: string[] }
  | {
      type: "files_move";
      paths: string[];
      dest: string;
      reviewed?: FilesIdentity[];
    }
  | { type: "files_trash"; paths: string[]; reviewed?: FilesIdentity[] }
  | FilesShownOperation
  | { type: "files_folder_create"; parent: string; name: string };
/** A share, move or trash of filter results on screen by position (1 is the first). The
 * coordinator resolves the positions with `FilesAgentRunner.shownPaths` before the owner
 * reviews the card, so `run` never receives this form. */
export type FilesShownOperation =
  | { type: "files_share"; shown: number[] }
  | { type: "files_move"; shown: number[]; dest: string }
  | { type: "files_trash"; shown: number[] };
export const FILES_CAPABILITY = "files.browser.v1";
/** `files_share`, `files_move` and `files_trash` may name files by their `shown` positions. */
export const FILES_SHOWN_TARGET_CAPABILITY = "files.shown-target.v1";
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
function shownPositions(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > FILES_PATHS_MAX ||
    value.some((n) => !Number.isSafeInteger(n) || (n as number) < 1)
  )
    throw Error("Invalid shown items");
  if (new Set(value).size !== value.length) throw Error("Duplicate files");
  return value.slice() as number[];
}
/** A share, move or trash that names shown positions instead of paths. */
export function filesShownTarget(
  op: FilesAgentOperation,
): op is FilesShownOperation {
  return (
    (op.type === "files_share" ||
      op.type === "files_move" ||
      op.type === "files_trash") &&
    "shown" in op
  );
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
      allowed(["type", "path", "shown"]);
      if (op.shown === undefined)
        return { type: "files_open", path: agentPath(op.path) };
      if (
        op.path !== undefined ||
        !Number.isSafeInteger(op.shown) ||
        (op.shown as number) < 1
      )
        throw Error("Invalid shown item");
      return { type: "files_open", shown: op.shown as number };
    case "files_share":
      if (op.shown !== undefined) {
        allowed(["type", "shown"]);
        return { type: "files_share", shown: shownPositions(op.shown) };
      }
      allowed(["type", "paths"]);
      return { type: "files_share", paths: paths(op.paths) };
    case "files_trash": {
      if (op.shown !== undefined) {
        allowed(["type", "shown"]);
        return { type: "files_trash", shown: shownPositions(op.shown) };
      }
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
      if (op.shown !== undefined) {
        allowed(["type", "shown", "dest"]);
        return {
          type: "files_move",
          shown: shownPositions(op.shown),
          dest: agentPath(op.dest, true),
        };
      }
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
const shownLabel = (list: readonly number[]) =>
  `${list.length === 1 ? "Item" : "Items"} ${list.join(", ")} in the results shown`;
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
      return {
        title: "Open file",
        description: "shown" in op ? `Shown item ${op.shown}` : place(op.path),
      };
    case "files_share":
      return "shown" in op
        ? {
            title: `Share ${count(op.shown.length)}`,
            description: shownLabel(op.shown),
          }
        : {
            title: `Share ${count(op.paths.length)}`,
            description: listed(op.paths),
          };
    case "files_trash":
      return "shown" in op
        ? {
            title: `Move ${count(op.shown.length)} to Trash`,
            description: shownLabel(op.shown),
          }
        : {
            title: `Move ${count(op.paths.length)} to Trash`,
            description: listed(op.paths),
          };
    case "files_move":
      return {
        title: `Move ${count("shown" in op ? op.shown.length : op.paths.length)}`,
        description: `${"shown" in op ? shownLabel(op.shown) : listed(op.paths)} → ${place(op.dest)}`,
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
  /** The paths at these positions (1 is the first) in the filter results on screen, in order.
   * Rejects when Files shows no filter results or a position shows nothing. */
  shownPaths?(shown: number[], signal: AbortSignal): Promise<string[]>;
  run(
    op: FilesAgentOperation,
    signal: AbortSignal,
    /** For direct actions only. Resolves after the host commits and renders Files. */
    openFiles?: () => Promise<boolean>,
  ): Promise<{ status: "succeeded" | "failed"; summary: string }>;
};
