/**
 * Launcher curation — the single source of truth for what shows in the app
 * launcher and on which page.
 *
 * The launcher renders two curated pages:
 *   - Page 1 "Apps"      — the everyday user-facing apps (curated order first,
 *                          then any other loaded plugin app).
 *   - Page 2 "Developer" — trajectory viewer, databases, runtime, logs, skills,
 *                          and plugins (plus any other developer-only view when
 *                          Developer Mode is on).
 *
 * Curation is a blocklist + canonical dedup, not a fixed allow-list: known apps
 * are ordered, removed apps are hidden, duplicate registrations collapse to one
 * tile, and everything else that is genuinely loaded still appears so installing
 * a new plugin app keeps working. Native-OS tiles (phone/messages/contacts/
 * camera/files) only appear on the AOSP ElizaOS fork.
 */

import { type EnabledViewKinds, isViewVisible } from "@elizaos/core";
import type { ViewEntry } from "../../hooks/view-catalog";

/** Page 1 — everyday apps, in display order. Other loaded apps append after. */
export const LAUNCHER_APPS_ORDER: readonly string[] = [
  "wallet",
  "automations",
  "browser",
  "character",
  "documents",
  "transcripts",
  "relationships",
  "memories",
  "feed",
  "stream",
  "settings",
];

/** Page 2 — developer tools, in display order. */
export const LAUNCHER_DEVELOPER_ORDER: readonly string[] = [
  "trajectories",
  "database",
  "runtime",
  "logs",
  "skills",
  "plugins",
];

/**
 * Native-OS surfaces that only belong on the AOSP ElizaOS fork. Appended to the
 * end of page 1 when the AOSP shell is active; hidden on web, desktop, iOS, and
 * stock Play-Store Android.
 */
export const LAUNCHER_AOSP_ONLY_IDS: readonly string[] = [
  "phone",
  "messages",
  "contacts",
  "camera",
  "files",
];

/**
 * Views that never appear in the launcher grid:
 *  - shell surfaces reached another way (chat is the home; views/apps launchers;
 *    background + voice are set from Settings/chat; character-select is inline),
 *  - removed apps (companion, model tester, shopify, wearables),
 *  - wallet sub-views (hyperliquid/polymarket open from inside the Wallet app).
 */
export const LAUNCHER_HIDDEN_IDS: ReadonlySet<string> = new Set([
  "chat",
  "views",
  "views-manager",
  "apps",
  "background",
  "voice",
  "character-select",
  "desktop",
  // Removed apps.
  "companion",
  "model-tester",
  "shopify",
  "facewear",
  "smartglasses",
  // Wallet sub-views — reached from inside the Wallet app, not the launcher.
  "hyperliquid",
  "polymarket",
]);

/**
 * Duplicate/alias ids collapsed onto one canonical launcher id. Kills the double
 * "Wallet" (standalone `wallet` view + `wallet.inventory` app-shell page +
 * builtin `inventory` tab) and double "Automations" (`automations` + `triggers`)
 * tiles, and folds the standalone tasks/todos surfaces into Automations.
 */
const CANONICAL_ID: ReadonlyMap<string, string> = new Map([
  ["inventory", "wallet"],
  ["wallet.inventory", "wallet"],
  ["@elizaos/plugin-wallet-ui", "wallet"],
  ["triggers", "automations"],
  ["tasks", "automations"],
  ["todos", "automations"],
  ["task-coordinator", "automations"],
  ["knowledge", "documents"],
  ["@elizaos/plugin-documents-routes", "documents"],
  ["plugins-page", "plugins"],
  ["trajectory-logger", "trajectories"],
  ["trajectory-viewer", "trajectories"],
  ["log-viewer", "logs"],
  ["database-viewer", "database"],
]);

export function canonicalLauncherId(id: string): string {
  return CANONICAL_ID.get(id) ?? id;
}

const APPS_INDEX = new Map(LAUNCHER_APPS_ORDER.map((id, i) => [id, i]));
const DEVELOPER_INDEX = new Map(
  LAUNCHER_DEVELOPER_ORDER.map((id, i) => [id, i]),
);
const AOSP_INDEX = new Map(LAUNCHER_AOSP_ONLY_IDS.map((id, i) => [id, i]));

/** True when a canonical id belongs on the Developer page. */
function isDeveloperEntry(canonicalId: string, entry: ViewEntry): boolean {
  if (DEVELOPER_INDEX.has(canonicalId)) return true;
  // Uncurated developer-only views (e.g. vector-browser) join the Developer
  // page rather than sitting among everyday apps.
  return entry.viewKind === "developer" || entry.developerOnly === true;
}

/**
 * Score competing registrations for the same canonical id so the richest one
 * wins the single tile (a loaded standalone view beats an app-shell alias beats
 * a builtin placeholder).
 */
function preferenceScore(entry: ViewEntry): number {
  let score = 0;
  if (entry.state === "loaded") score += 100;
  if (entry.kind === "view") score += 50;
  if (entry.builtin) score += 10;
  if (canonicalLauncherId(entry.id) === entry.id) score += 20;
  return score;
}

export interface CurateLauncherOptions {
  /** Include the native-OS tiles (phone/messages/contacts/camera/files). */
  isAosp: boolean;
  /** Which view kinds the user/build has enabled (system+release always on). */
  enabledKinds: EnabledViewKinds;
}

function comparator(indexes: Array<Map<string, number>>) {
  return (a: ViewEntry, b: ViewEntry): number => {
    for (const index of indexes) {
      const ai = index.get(a.id);
      const bi = index.get(b.id);
      if (ai != null || bi != null) {
        // Curated ids sort by their list order and before uncurated ids.
        if (ai == null) return 1;
        if (bi == null) return -1;
        if (ai !== bi) return ai - bi;
      }
    }
    return a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  };
}

/**
 * Curate raw launcher entries into the fixed page layout. Returns one array per
 * rendered page: `[appsPage]`, or `[appsPage, developerPage]` when a developer
 * tool is present. Entries are deduped by canonical id, hidden/removed apps are
 * dropped, native-OS tiles are AOSP-gated, and uncurated preview/developer views
 * follow the Developer-Mode toggle.
 */
export function curateLauncherPages(
  entries: ViewEntry[],
  { isAosp, enabledKinds }: CurateLauncherOptions,
): ViewEntry[][] {
  const byCanonical = new Map<string, ViewEntry>();
  for (const entry of entries) {
    const canonicalId = canonicalLauncherId(entry.id);
    if (LAUNCHER_HIDDEN_IDS.has(canonicalId)) continue;
    if (AOSP_INDEX.has(canonicalId) && !isAosp) continue;

    const curated =
      APPS_INDEX.has(canonicalId) ||
      DEVELOPER_INDEX.has(canonicalId) ||
      AOSP_INDEX.has(canonicalId);
    // Curated tiles always show; uncurated extras respect the visibility toggle
    // so preview/developer plugin views only surface when their kind is enabled.
    if (!curated && !isViewVisible(entry, enabledKinds)) continue;

    const existing = byCanonical.get(canonicalId);
    if (!existing || preferenceScore(entry) > preferenceScore(existing)) {
      // Preserve the canonical id so navigation + telemetry stay stable even
      // when an aliased registration (e.g. `wallet.inventory`) wins the tile.
      byCanonical.set(canonicalId, { ...entry, id: canonicalId });
    }
  }

  const appsPage: ViewEntry[] = [];
  const developerPage: ViewEntry[] = [];
  for (const [canonicalId, entry] of byCanonical) {
    if (isDeveloperEntry(canonicalId, entry)) developerPage.push(entry);
    else appsPage.push(entry);
  }

  appsPage.sort(comparator([APPS_INDEX, AOSP_INDEX]));
  developerPage.sort(comparator([DEVELOPER_INDEX]));

  const pages: ViewEntry[][] = [];
  if (appsPage.length > 0) pages.push(appsPage);
  if (developerPage.length > 0) pages.push(developerPage);
  return pages;
}
