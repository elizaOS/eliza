/**
 * Launcher curation — the single source of truth for what shows in the app
 * launcher and on which page.
 *
 * The launcher renders two curated pages:
 *   - Page 1 "Apps"      — the everyday user-facing apps (curated order first,
 *                          then any other loaded plugin app).
 *   - Page 2 "Developer" — trajectory viewer, databases, runtime, logs, skills,
 *                          and plugins (plus any other developer-only view).
 *                          The ENTIRE page — curated tiles included — renders
 *                          only when the "Developer views" Settings toggle is
 *                          on. It is off by default on every build, dev builds
 *                          included, so users and developers see the same
 *                          launcher out of the box.
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
  "chat",
  "settings",
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
 *  - shell surfaces reached another way (views/apps launchers; background +
 *    voice are set from Settings/chat; character-select is inline),
 *  - removed apps (companion, model tester, shopify, wearables),
 *  - wallet sub-views (hyperliquid/polymarket open from inside the Wallet app).
 */
export const LAUNCHER_HIDDEN_IDS: ReadonlySet<string> = new Set([
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
  // Legacy alias for the relationships/contact-graph surface: `rolodex` is a
  // routable tab (TAB_PATHS "/rolodex") with a launcher tile but NO directViews
  // branch in renderStaticViewRouterTab, so tapping it lands on the
  // ViewUnavailableFallback (bounces the user back to the launcher). The real
  // contact surface is `relationships`; hide this dead alias.
  "rolodex",
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
  // `rolodex` is the legacy builtin tab for the contact book; its route has no
  // renderer (App.tsx directViews) so a standalone tile would open "view
  // unavailable" next to the working Relationships tile — collapse them.
  ["rolodex", "relationships"],
  ["log-viewer", "logs"],
  ["database-viewer", "database"],
  // Triple "Fine-Tuning" tile: the `advanced` builtin tab alias, the
  // `fine-tuning` builtin tab, and the plugin-training app registration
  // (view id `training`) all route to /apps/fine-tuning — collapse to one
  // tile (#10710).
  ["advanced", "fine-tuning"],
  ["training", "fine-tuning"],
  ["plugin-training", "fine-tuning"],
  ["@elizaos/plugin-training", "fine-tuning"],
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

/**
 * Launcher tiles that back an Eliza Cloud surface and must not appear unless the
 * user is signed into cloud. `cloud-apps` (the Cloud Applications dashboard,
 * registered by `@elizaos/app`'s cloud-apps-view) is `viewKind: "release"`, so
 * without this gate it shows as an "Apps" tile even when cloud is
 * disconnected. (#10725)
 */
export const LAUNCHER_CLOUD_IDS: ReadonlySet<string> = new Set(["cloud-apps"]);

export interface CurateLauncherOptions {
  /** Include the native-OS tiles (phone/messages/contacts/camera/files). */
  isAosp: boolean;
  /** Which view kinds the user/build has enabled (system+release always on). */
  enabledKinds: EnabledViewKinds;
  /** True when signed into Eliza Cloud; gates cloud-only launcher tiles. */
  cloudActive: boolean;
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
 * rendered page: `[appsPage]`, or `[appsPage, developerPage]` when the
 * "Developer views" toggle is on and a developer tool is present. Entries are
 * deduped by canonical id, hidden/removed apps are dropped, native-OS tiles are
 * AOSP-gated, and every developer view — curated or not — follows the toggle
 * (default off on all builds), while preview views follow theirs.
 */
export function curateLauncherPages(
  entries: ViewEntry[],
  { isAosp, enabledKinds, cloudActive }: CurateLauncherOptions,
): ViewEntry[][] {
  const byCanonical = new Map<string, ViewEntry>();
  for (const entry of entries) {
    const canonicalId = canonicalLauncherId(entry.id);
    if (LAUNCHER_HIDDEN_IDS.has(canonicalId)) continue;
    if (AOSP_INDEX.has(canonicalId) && !isAosp) continue;
    // Cloud-only tiles (e.g. the Cloud Applications dashboard) never surface
    // unless the user is signed into Eliza Cloud.
    if (LAUNCHER_CLOUD_IDS.has(canonicalId) && !cloudActive) continue;

    // Developer tooling — curated (trajectories/database/runtime/logs/skills/
    // plugins) and uncurated alike — is gated on the "Developer views" toggle,
    // which is off by default on EVERY build (dev included). No tile may reach
    // the Developer page around the toggle.
    if (isDeveloperEntry(canonicalId, entry) && !enabledKinds.developer) {
      continue;
    }

    const curated =
      APPS_INDEX.has(canonicalId) ||
      DEVELOPER_INDEX.has(canonicalId) ||
      AOSP_INDEX.has(canonicalId);
    // Curated apps-page tiles always show; uncurated extras respect the
    // visibility toggles so preview plugin views only surface when their kind
    // is enabled.
    if (!curated && !isViewVisible(entry, enabledKinds)) continue;

    const existing = byCanonical.get(canonicalId);
    if (!existing || preferenceScore(entry) > preferenceScore(existing)) {
      // Preserve the canonical id so navigation + telemetry stay stable even
      // when an aliased registration (e.g. `wallet.inventory`) wins the tile.
      // When the id is REWRITTEN (an alias won), drop its alias `path` too, so
      // handleLaunch falls back to `/apps/<canonicalId>` — the route the dedup
      // presumes — instead of navigating to the alias route while recents +
      // telemetry record the canonical id (a real launch/telemetry mismatch).
      byCanonical.set(
        canonicalId,
        canonicalId === entry.id
          ? entry
          : { ...entry, id: canonicalId, path: undefined },
      );
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
