/**
 * Authoritative source of the plugin-view declarations the UI-smoke API stub
 * serves, plus the parity check that pins them to the plugins that actually
 * ship those views today.
 *
 * The smoke stub (`playwright-ui-smoke-api-stub.mjs`) answers `GET /api/views`
 * with these rows and serves each view's `/api/views/<id>/bundle.js`. If a row
 * survives here after its plugin is deleted, an audit renders a fabricated
 * surface for a view production no longer registers — proving nothing. So the
 * declarations live here next to `checkSmokeViewParity`, which fails the moment
 * a declared view's plugin directory is gone or no longer exports the named
 * component. Removed plugin IDs (Shopify, Steward, Social Alpha) are therefore
 * kept out and cannot silently reappear.
 *
 * `resolveBundleProvenance` is the single decision the stub uses when serving a
 * bundle: serve the real built `dist/views/bundle.js`, or — only outside audit
 * mode — a clearly-marked synthesized placeholder. In audit mode a missing real
 * bundle is a hard, observable failure, never a generic fabrication.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * One GUI declaration per shipped plugin view: `[id, label, pluginDirName,
 * path, componentExport]`. Every entry must pass `checkSmokeViewParity` — its
 * plugin directory exists and its source both declares the `id` and exports the
 * `componentExport`. Do NOT add a view here for a plugin that no longer exists.
 */
export const smokeViewDeclarations = [
  ["birdclaw", "Birdclaw", "plugin-birdclaw", "/birdclaw", "BirdclawView"],
  ["contacts", "Contacts", "plugin-contacts", "/contacts", "ContactsView"],
  [
    "hyperliquid",
    "Hyperliquid",
    "plugin-hyperliquid",
    "/hyperliquid",
    "HyperliquidView",
  ],
  // The decomposed personal-assistant domain views are the real surfaces (the
  // old monolithic `lifeops` overview view was removed). `documents` is
  // intentionally absent — its `/documents` path collides with the built-in
  // Knowledge tab (`App.tsx` findView matches `/${tab}`).
  ["calendar", "Calendar", "plugin-calendar", "/calendar", "CalendarView"],
  ["finances", "Finances", "plugin-finances", "/finances", "FinancesView"],
  ["focus", "Focus", "plugin-blocker", "/focus", "FocusView"],
  ["goals", "Goals", "plugin-goals", "/goals", "GoalsView"],
  ["health", "Health", "plugin-health", "/health", "HealthView"],
  ["inbox", "Inbox", "plugin-inbox", "/inbox", "InboxView"],
  ["todos", "Todos", "plugin-todos", "/todos", "TodosView"],
  [
    "relationships",
    "Relationships",
    "plugin-relationships",
    "/relationships",
    "RelationshipsView",
  ],
  ["messages", "Messages", "plugin-messages", "/messages", "MessagesView"],
  [
    "model-tester",
    "Model Tester",
    "app-model-tester",
    "/model-tester",
    "ModelTesterView",
  ],
  ["phone", "Phone", "plugin-phone", "/phone", "PhoneView"],
  [
    "polymarket",
    "Polymarket",
    "plugin-polymarket",
    "/polymarket",
    "PolymarketView",
  ],
  ["wallet", "Wallet", "plugin-wallet-ui", "/wallet", "InventoryView"],
  [
    "vector-browser",
    "Vector Browser",
    "plugin-vector-browser",
    "/vector-browser",
    "VectorBrowserView",
  ],
  ["feed", "Feed", "plugin-feed", "/feed", "FeedView"],
  ["views-manager", "Views", "plugin-app-control", "/views", "ViewManagerView"],
  [
    "screenshare",
    "Screenshare",
    "plugin-screenshare",
    "/screenshare",
    "ScreenshareView",
  ],
  [
    "task-coordinator",
    "Task Coordinator",
    "plugin-task-coordinator",
    "/task-coordinator",
    "TaskCoordinatorView",
  ],
  [
    "orchestrator",
    "Orchestrator",
    "plugin-task-coordinator",
    "/orchestrator",
    "OrchestratorView",
  ],
  [
    "trajectory-logger",
    "Trajectory Logger",
    "plugin-trajectory-logger",
    "/trajectory-logger",
    "TrajectoryLoggerView",
  ],
  ["training", "Fine Tuning", "plugin-training", "/training", "FineTuningView"],
];

/**
 * Normalize a declaration tuple to a named record. Kept internal so callers
 * consume `id` / `pluginDirName` / `componentExport` rather than tuple indices.
 */
function toDeclaration(tuple) {
  const [id, label, pluginDirName, viewPath, componentExport] = tuple;
  return { id, label, pluginDirName, viewPath, componentExport };
}

function readSourceFiles(dir) {
  const sources = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // error-policy:J3 a plugin dir that vanished mid-scan is reported by the
      // caller as a parity miss (missing directory), not swallowed as "clean".
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        sources.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return sources;
}

/**
 * Check every smoke view declaration against the plugin that must register it.
 * A declaration is in parity when the plugin directory exists and its source
 * both declares the view `id` and exports the named component. Returns the full
 * declaration list plus the misses so a test can assert the shipped set is
 * clean AND that a removed plugin id would be caught.
 */
export function checkSmokeViewParity(
  repoRoot,
  declarations = smokeViewDeclarations,
) {
  const pluginsDir = path.join(repoRoot, "plugins");
  const missing = [];
  for (const tuple of declarations) {
    const { id, pluginDirName, componentExport } = toDeclaration(tuple);
    const pluginDir = path.join(pluginsDir, pluginDirName);
    let dirExists = false;
    try {
      dirExists = statSync(pluginDir).isDirectory();
    } catch {
      dirExists = false;
    }
    if (!dirExists) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: "plugin-directory-missing",
      });
      continue;
    }
    const sources = readSourceFiles(path.join(pluginDir, "src"));
    const declaresId = sources.some((source) => source.includes(`"${id}"`));
    const exportsComponent = sources.some((source) =>
      source.includes(componentExport),
    );
    if (!declaresId || !exportsComponent) {
      missing.push({
        id,
        pluginDirName,
        componentExport,
        reason: !exportsComponent
          ? "component-export-missing"
          : "view-id-not-declared",
      });
    }
  }
  return { declarations, missing, ok: missing.length === 0 };
}

/**
 * Provenance the smoke stub must attach when serving a plugin-view bundle. The
 * value flows out on the `X-Eliza-View-Bundle-Provenance` response header so an
 * audit can assert WHICH bundle rendered — the real built one or a marked
 * placeholder — and never mistake a fabricated surface for the production one.
 */
export const VIEW_BUNDLE_PROVENANCE_HEADER = "X-Eliza-View-Bundle-Provenance";

/**
 * Decide how the stub serves a view's bundle. In audit mode
 * (`requireRealBundle`) a missing real `dist/views/bundle.js` is a hard failure
 * (`status` 424, mode `missing-real-bundle`) — the stub must NOT fabricate a
 * generic bundle for a production-declared view. Outside audit mode a missing
 * bundle degrades to a clearly-marked synthesized placeholder so the offline
 * keyless smoke can still exercise routing, but the provenance says so.
 */
export function resolveBundleProvenance({
  viewId,
  realBundleExists,
  requireRealBundle,
}) {
  if (realBundleExists) {
    return { mode: "real-dist", status: 200, synthesized: false };
  }
  if (requireRealBundle) {
    return { mode: "missing-real-bundle", status: 424, synthesized: false };
  }
  const dedicated = new Set(["screenshare", "task-coordinator"]);
  return {
    mode: dedicated.has(viewId)
      ? `synthesized-${viewId}`
      : "synthesized-generic",
    status: 200,
    synthesized: true,
  };
}

/** True when `plugins/<pluginDirName>/dist/views/bundle.js` exists on disk. */
export function realViewBundleExists(repoRoot, pluginDirName) {
  return existsSync(
    path.join(repoRoot, "plugins", pluginDirName, "dist", "views", "bundle.js"),
  );
}
