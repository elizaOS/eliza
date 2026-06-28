import { isViewVisible, resolveViewKind, type ViewKind } from "@elizaos/core";
import type { ViewEntry } from "../../hooks/view-catalog";
import type { EnabledViewKinds } from "../../state/useViewKinds";

const SYSTEM_ORDER = [
  "tutorial",
  "help",
  "documents",
  "character",
  "settings",
  "tasks",
  "transcripts",
  "wallet",
  "browser",
  "files",
  "skills",
  "feed",
  "relationships",
] as const;

const DEVELOPER_ORDER = [
  "orchestrator",
  "logs",
  "database",
  "trajectories",
] as const;

const SYSTEM_INDEX = new Map<string, number>(
  SYSTEM_ORDER.map((id, index) => [id, index]),
);
const DEVELOPER_INDEX = new Map<string, number>(
  DEVELOPER_ORDER.map((id, index) => [id, index]),
);

const ID_ALIASES = new Map<string, string>([
  ["knowledge", "documents"],
  ["@elizaos/plugin-documents-routes", "documents"],
  ["inventory", "wallet"],
  ["@elizaos/plugin-wallet-ui", "wallet"],
  ["wallet.inventory", "wallet"],
  ["todos", "tasks"],
  ["task-coordinator", "tasks"],
  ["@elizaos/plugin-feed", "feed"],
  ["@elizaos/plugin-relationships", "relationships"],
  ["@elizaos/plugin-task-coordinator", "orchestrator"],
  ["log-viewer", "logs"],
  ["database-viewer", "database"],
  ["trajectory-viewer", "trajectories"],
  ["trajectory-logger", "trajectories"],
  ["@elizaos/plugin-trajectory-logger", "trajectories"],
]);

const PATH_ALIASES: Array<[RegExp, string]> = [
  [/^\/(?:apps\/)?smartglasses(?:\/|$)/, "smartglasses"],
  [/^\/(?:apps\/)?facewear(?:\/|$)/, "facewear"],
  [/^\/(?:apps\/)?tasks(?:\/|$)/, "tasks"],
  [/^\/todos(?:\/|$)/, "tasks"],
  [/^\/(?:character\/documents|documents)(?:\/|$)/, "documents"],
  [/^\/(?:wallet|inventory)(?:\/|$)/, "wallet"],
  [/^\/(?:apps\/)?transcripts(?:\/|$)/, "transcripts"],
  [/^\/(?:apps\/)?relationships(?:\/|$)/, "relationships"],
  [/^\/(?:apps\/)?logs(?:\/|$)/, "logs"],
  [/^\/(?:apps\/)?database(?:\/|$)/, "database"],
  [/^\/(?:apps\/trajectories|trajectory-logger)(?:\/|$)/, "trajectories"],
  [/^\/orchestrator(?:\/|$)/, "orchestrator"],
];

const PREFERRED_PATH_BY_CANONICAL_ID = new Map<string, string>([
  ["documents", "/character/documents"],
  ["tasks", "/apps/tasks"],
  ["wallet", "/wallet"],
  ["relationships", "/apps/relationships"],
  ["logs", "/apps/logs"],
  ["database", "/apps/database"],
  ["trajectories", "/apps/trajectories"],
]);

function normalizedPath(path: string | undefined): string {
  if (!path) return "";
  const trimmed = path.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

export function canonicalSpringboardId(entry: Pick<ViewEntry, "id" | "path">) {
  const byId = ID_ALIASES.get(entry.id) ?? entry.id;
  if (SYSTEM_INDEX.has(byId) || DEVELOPER_INDEX.has(byId)) return byId;

  const path = normalizedPath(entry.path);
  for (const [pattern, canonical] of PATH_ALIASES) {
    if (pattern.test(path)) return canonical;
  }
  return byId;
}

export function springboardKindForCanonicalId(canonicalId: string): ViewKind {
  if (SYSTEM_INDEX.has(canonicalId)) return "system";
  if (DEVELOPER_INDEX.has(canonicalId)) return "developer";
  return "preview";
}

export function normalizeSpringboardEntry(entry: ViewEntry): ViewEntry {
  const canonicalId = canonicalSpringboardId(entry);
  const viewKind = springboardKindForCanonicalId(canonicalId);
  return {
    ...entry,
    developerOnly: viewKind === "developer",
    viewKind,
  };
}

export function isCuratedSpringboardEntryVisible(
  entry: ViewEntry,
  enabledKinds: EnabledViewKinds,
): boolean {
  return isViewVisible(entry, enabledKinds);
}

function preferenceScore(entry: ViewEntry): number {
  const canonicalId = canonicalSpringboardId(entry);
  const path = normalizedPath(entry.path);
  let score = 0;
  if (entry.state === "loaded") score += 100;
  if (entry.kind === "view") score += 50;
  if (entry.id === canonicalId) score += 20;
  if (entry.builtin) score += 10;
  if (PREFERRED_PATH_BY_CANONICAL_ID.get(canonicalId) === path) score += 40;
  return score;
}

export function dedupeSpringboardEntries(entries: ViewEntry[]): ViewEntry[] {
  const order: string[] = [];
  const byCanonical = new Map<string, ViewEntry>();

  for (const entry of entries) {
    const canonicalId = canonicalSpringboardId(entry);
    const existing = byCanonical.get(canonicalId);
    if (!existing) {
      order.push(canonicalId);
      byCanonical.set(canonicalId, entry);
      continue;
    }
    if (preferenceScore(entry) > preferenceScore(existing)) {
      byCanonical.set(canonicalId, entry);
    }
  }

  return order
    .map((id) => byCanonical.get(id))
    .filter((entry): entry is ViewEntry => Boolean(entry));
}

function orderTuple(entry: ViewEntry): [number, number, string] {
  const canonicalId = canonicalSpringboardId(entry);
  const kind = resolveViewKind(entry);
  if (kind === "system") {
    return [0, SYSTEM_INDEX.get(canonicalId) ?? Number.MAX_SAFE_INTEGER, ""];
  }
  if (kind === "developer") {
    return [1, DEVELOPER_INDEX.get(canonicalId) ?? Number.MAX_SAFE_INTEGER, ""];
  }
  return [2, Number.MAX_SAFE_INTEGER, entry.label];
}

export function compareSpringboardEntries(
  left: ViewEntry,
  right: ViewEntry,
): number {
  const [leftGroup, leftOrder, leftLabel] = orderTuple(left);
  const [rightGroup, rightOrder, rightLabel] = orderTuple(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return leftLabel.localeCompare(rightLabel, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function springboardPageGroups(entries: ViewEntry[]): string[][] {
  const system: string[] = [];
  const developer: string[] = [];
  const preview: string[] = [];

  for (const entry of entries) {
    const kind = resolveViewKind(entry);
    if (kind === "system") system.push(entry.id);
    else if (kind === "developer") developer.push(entry.id);
    else preview.push(entry.id);
  }

  return [system, developer, preview].filter((page) => page.length > 0);
}
