/**
 * Unit tests for the Route Coverage app shell contract and coverage guardrail.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRouteCatalog } from "../../app-core/src/api/dev-route-catalog";
import { discoverSideEffectAppModules } from "../vite/app-side-effect-modules";
import {
  DIRECT_ROUTE_CASES,
  MANAGER_VISIBLE_VIEW_TILE_CASES,
} from "./ui-smoke/apps-session-route-cases";

/**
 * UI route-coverage gate (vitest, boot-free).
 *
 * Static analog of the deterministic action-coverage gate: the canonical route
 * catalog (buildRouteCatalog, mirroring @elizaos/ui TAB_PATHS) plus app-window
 * tool routes are the surface a user can reach; every one of those paths must
 * appear in the all-pages click-safe smoke matrix, and the default-visible app
 * tiles must match the catalog. A new view/page/tile that ships without smoke
 * coverage fails CI here instead of silently passing.
 *
 * This is the same assertion that previously lived in the ui-smoke Playwright
 * spec, but that spec was trapped behind a ~12 min cold-renderer webServer boot
 * (playwright.ui-smoke.config.ts) and so never ran in CI. The check is pure
 * (file reads + catalog build + set diffs), so it belongs in cheap vitest where
 * it can be enforced on every PR.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const ALL_PAGES_SPEC = path.join(
  HERE,
  "ui-smoke",
  "all-pages-clicksafe.spec.ts",
);
const PLUGIN_VIEW_CASES_SOURCE = path.join(
  HERE,
  "ui-smoke",
  "plugin-view-cases.ts",
);
const PLUGIN_VIEW_VISUAL_REVIEW_REPORT = path.resolve(
  HERE,
  "fixtures",
  "plugin-view-visual-review.md",
);
const INTERNAL_TOOL_APPS_SOURCE = path.resolve(
  HERE,
  "../../ui/src/components/apps/internal-tool-apps.ts",
);
const APP_MAIN_SOURCE = path.resolve(HERE, "../src/main.tsx");

type PluginViewCase = {
  manifestPath: string;
  id: string;
  viewType: "gui" | "tui" | "xr";
  path: string;
};

/**
 * A collapsed operator view: ONE declaration that draws several modalities from
 * one source (`modalities`), one `path`, one `componentExport` (a
 * SpatialSurface-wrapped view). The gate asserts that single declaration keeps
 * its canonical path, bundle, component, and modality coverage.
 */
type PluginViewManifestContract = {
  manifestPath: string;
  id: string;
  modalities: ReadonlyArray<"gui" | "tui" | "xr">;
  path: string;
  componentExport: string;
};

const PLUGIN_VIEW_MANIFESTS = [
  "plugins/plugin-birdclaw/src/plugin.ts",
  "plugins/plugin-contacts/src/plugin.ts",
  "plugins/plugin-hyperliquid/src/plugin.ts",
  "plugins/plugin-messages/src/plugin.ts",
  "plugins/app-model-tester/src/plugin.ts",
  "plugins/plugin-blocker/src/plugin.ts",
  "plugins/plugin-calendar/src/plugin.ts",
  "plugins/plugin-documents/src/plugin.ts",
  "plugins/plugin-finances/src/plugin.ts",
  "plugins/plugin-goals/src/plugin.ts",
  "plugins/plugin-health/src/index.ts",
  "plugins/plugin-inbox/src/plugin.ts",
  "plugins/plugin-relationships/src/plugin.ts",
  "plugins/plugin-todos/src/index.ts",
  "plugins/plugin-phone/src/plugin.ts",
  "plugins/plugin-polymarket/src/plugin.ts",
  "plugins/plugin-shopify/src/plugin.ts",
  "plugins/plugin-wallet-ui/src/plugin.ts",
  "plugins/plugin-vector-browser/src/plugin.ts",
  "plugins/plugin-feed/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-social-alpha/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/plugin.ts",
  "plugins/plugin-training/src/setup-routes.ts",
  "plugins/plugin-facewear/src/index.ts",
] as const;

const APP_SHELL_REGISTRATION_SOURCES = [
  "plugins/plugin-facewear/src/register.ts",
  "plugins/plugin-phone/src/register-companion-page.ts",
  "plugins/plugin-task-coordinator/src/register.ts",
  "plugins/plugin-wallet-ui/src/register-routes.ts",
] as const;

const NOT_APP_BOOT_LOADED_VIEW_MANIFESTS: Readonly<Record<string, string>> = {
  "plugins/plugin-birdclaw/src/plugin.ts":
    "Birdclaw is an opt-in agent runtime plugin (local birdclaw.sh archive); its view registers when the agent enables the plugin, not via the app boot loader.",
  "plugins/plugin-app-control/src/index.ts":
    "View manager routes are built into the app shell and tested through /views; this plugin supplies agent actions plus the manager view declaration.",
  "plugins/plugin-blocker/src/plugin.ts":
    "Focus is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-calendar/src/plugin.ts":
    "Calendar is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-documents/src/plugin.ts":
    "Documents is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-finances/src/plugin.ts":
    "Finances is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-goals/src/plugin.ts":
    "Goals is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-health/src/index.ts":
    "Health is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-inbox/src/plugin.ts":
    "Inbox is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-relationships/src/plugin.ts":
    "Relationships is the entity/relationship knowledge-graph viewer; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
  "plugins/plugin-screenshare/src/index.ts":
    "Screenshare is registered by runtime capability loading, not the app boot side-effect loader.",
  "plugins/plugin-social-alpha/src/index.ts":
    "Social Alpha is an opt-in agent runtime plugin; its leaderboard view registers when the agent enables the plugin, not via the app boot loader.",
  "plugins/plugin-todos/src/index.ts":
    "Todos is a decomposed personal-assistant domain view; it is discoverable through the View Manager but not yet a boot-loaded renderer module.",
};

const BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE: Record<string, string | null> = {
  "@elizaos/plugin-contacts": "plugins/plugin-contacts/src/plugin.ts",
  "@elizaos/plugin-native-settings": null,
  "@elizaos/plugin-facewear": "plugins/plugin-facewear/src/index.ts",
  "@elizaos/plugin-feed": "plugins/plugin-feed/src/index.ts",
  "@elizaos/plugin-hyperliquid": "plugins/plugin-hyperliquid/src/plugin.ts",
  // PA no longer declares a view (the LifeOps overview was removed); it is a
  // boot plugin with no renderer module.
  "@elizaos/plugin-personal-assistant": null,
  "@elizaos/plugin-messages": "plugins/plugin-messages/src/plugin.ts",
  "@elizaos/plugin-phone": "plugins/plugin-phone/src/plugin.ts",
  "@elizaos/plugin-polymarket": "plugins/plugin-polymarket/src/plugin.ts",
  "@elizaos/plugin-shopify": "plugins/plugin-shopify/src/plugin.ts",
  "@elizaos/plugin-task-coordinator":
    "plugins/plugin-task-coordinator/src/index.ts",
  "@elizaos/plugin-task-coordinator/register":
    "plugins/plugin-task-coordinator/src/index.ts",
  "@elizaos/plugin-training": "plugins/plugin-training/src/setup-routes.ts",
  "@elizaos/plugin-trajectory-logger":
    "plugins/plugin-trajectory-logger/src/plugin.ts",
  "@elizaos/plugin-vector-browser":
    "plugins/plugin-vector-browser/src/plugin.ts",
  "@elizaos/plugin-wallet-ui": "plugins/plugin-wallet-ui/src/plugin.ts",
  "@elizaos/plugin-wifi": null,
  "@elizaos/app-model-tester": "plugins/app-model-tester/src/plugin.ts",
};

const KNOWN_XR_VIEW_CASES: readonly PluginViewCase[] = [
  {
    manifestPath: "plugins/plugin-birdclaw/src/plugin.ts",
    id: "birdclaw",
    viewType: "xr",
    path: "/birdclaw",
  },
  {
    manifestPath: "plugins/plugin-contacts/src/plugin.ts",
    id: "contacts",
    viewType: "xr",
    path: "/contacts",
  },
  {
    manifestPath: "plugins/plugin-hyperliquid/src/plugin.ts",
    id: "hyperliquid",
    viewType: "xr",
    path: "/hyperliquid",
  },
  {
    manifestPath: "plugins/plugin-messages/src/plugin.ts",
    id: "messages",
    viewType: "xr",
    path: "/messages",
  },
  {
    manifestPath: "plugins/app-model-tester/src/plugin.ts",
    id: "model-tester",
    viewType: "xr",
    path: "/model-tester",
  },
  {
    manifestPath: "plugins/plugin-phone/src/plugin.ts",
    id: "phone",
    viewType: "xr",
    path: "/phone",
  },
  {
    manifestPath: "plugins/plugin-polymarket/src/plugin.ts",
    id: "polymarket",
    viewType: "xr",
    path: "/polymarket",
  },
  {
    manifestPath: "plugins/plugin-shopify/src/plugin.ts",
    id: "shopify",
    viewType: "xr",
    path: "/shopify",
  },
  {
    manifestPath: "plugins/plugin-wallet-ui/src/plugin.ts",
    id: "wallet",
    viewType: "xr",
    path: "/wallet",
  },
  {
    manifestPath: "plugins/plugin-feed/src/index.ts",
    id: "feed",
    viewType: "xr",
    path: "/feed",
  },
  {
    manifestPath: "plugins/plugin-app-control/src/index.ts",
    id: "views-manager",
    viewType: "xr",
    path: "/views",
  },
  {
    manifestPath: "plugins/plugin-screenshare/src/index.ts",
    id: "screenshare",
    viewType: "xr",
    path: "/screenshare",
  },
  {
    manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
    id: "task-coordinator",
    viewType: "xr",
    path: "/task-coordinator",
  },
  {
    manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
    id: "orchestrator",
    viewType: "xr",
    path: "/orchestrator",
  },
  {
    manifestPath: "plugins/plugin-trajectory-logger/src/plugin.ts",
    id: "trajectory-logger",
    viewType: "xr",
    path: "/trajectory-logger",
  },
  {
    manifestPath: "plugins/plugin-training/src/setup-routes.ts",
    id: "training",
    viewType: "xr",
    path: "/apps/fine-tuning",
  },
  {
    manifestPath: "plugins/plugin-blocker/src/plugin.ts",
    id: "focus",
    viewType: "xr",
    path: "/focus",
  },
  {
    manifestPath: "plugins/plugin-calendar/src/plugin.ts",
    id: "calendar",
    viewType: "xr",
    path: "/calendar",
  },
  {
    manifestPath: "plugins/plugin-documents/src/plugin.ts",
    id: "documents",
    viewType: "xr",
    path: "/documents",
  },
  {
    manifestPath: "plugins/plugin-finances/src/plugin.ts",
    id: "finances",
    viewType: "xr",
    path: "/finances",
  },
  {
    manifestPath: "plugins/plugin-goals/src/plugin.ts",
    id: "goals",
    viewType: "xr",
    path: "/goals",
  },
  {
    manifestPath: "plugins/plugin-health/src/index.ts",
    id: "health",
    viewType: "xr",
    path: "/health",
  },
  {
    manifestPath: "plugins/plugin-inbox/src/plugin.ts",
    id: "inbox",
    viewType: "xr",
    path: "/inbox",
  },
  {
    manifestPath: "plugins/plugin-relationships/src/plugin.ts",
    id: "relationships",
    viewType: "xr",
    path: "/relationships",
  },
  {
    manifestPath: "plugins/plugin-todos/src/index.ts",
    id: "todos",
    viewType: "xr",
    path: "/todos",
  },
  {
    manifestPath: "plugins/plugin-vector-browser/src/plugin.ts",
    id: "vector-browser",
    viewType: "xr",
    path: "/vector-browser",
  },
  {
    manifestPath: "plugins/plugin-social-alpha/src/index.ts",
    id: "social-alpha",
    viewType: "xr",
    path: "/social-alpha",
  },
  {
    // Facewear collapsed to one declaration: gui/xr/tui all draw from the same
    // `/apps/facewear` route (the standalone `/apps/facewear/xr` route is gone).
    manifestPath: "plugins/plugin-facewear/src/index.ts",
    id: "facewear",
    viewType: "xr",
    path: "/apps/facewear",
  },
  {
    manifestPath: "plugins/plugin-facewear/src/index.ts",
    id: "smartglasses",
    viewType: "xr",
    path: "/apps/smartglasses",
  },
];

const ALL_MODALITIES: ReadonlyArray<"gui" | "tui" | "xr"> = [
  "gui",
  "xr",
  "tui",
];

const OPERATOR_VIEW_MANIFEST_CONTRACTS: readonly PluginViewManifestContract[] =
  [
    {
      manifestPath: "plugins/plugin-feed/src/index.ts",
      id: "feed",
      modalities: ALL_MODALITIES,
      path: "/feed",
      componentExport: "FeedView",
    },
    {
      manifestPath: "plugins/plugin-screenshare/src/index.ts",
      id: "screenshare",
      modalities: ALL_MODALITIES,
      path: "/screenshare",
      componentExport: "ScreenshareView",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "task-coordinator",
      modalities: ALL_MODALITIES,
      path: "/task-coordinator",
      componentExport: "TaskCoordinatorView",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "orchestrator",
      modalities: ALL_MODALITIES,
      path: "/orchestrator",
      componentExport: "OrchestratorView",
    },
  ];

function pathsFromSource(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

function viewObjects(source: string): string[] {
  return arrayObjectChunks(source, "views").filter(
    (chunk) => chunk.includes("id:") && chunk.includes("componentExport:"),
  );
}

function arrayObjectChunks(source: string, arrayField: string): string[] {
  const arrayFieldPattern = new RegExp(`${arrayField}:`);
  const fieldMatch = arrayFieldPattern.exec(source);
  const arrayFieldStart = fieldMatch?.index ?? -1;
  if (arrayFieldStart === -1) return [];
  const arrayStart = source.indexOf("[", arrayFieldStart);
  if (arrayStart === -1) return [];

  let depth = 0;
  let arrayEnd = -1;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      arrayEnd = index;
      break;
    }
  }
  if (arrayEnd === -1) return [];

  const arraySource = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let objectStart = -1;
  depth = 0;
  for (let index = 0; index < arraySource.length; index += 1) {
    const char = arraySource[index];
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(arraySource.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }

  return objects;
}

function stringField(source: string, field: string): string | null {
  const match = source.match(new RegExp(`${field}:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

/**
 * The surfaces a single view object draws. A collapsed declaration uses
 * `modalities: ["gui","xr","tui"]` — one source, one route, drawn in several
 * modes — and expands to one logical case per surface (all sharing the same
 * `path`). A legacy declaration uses a single `viewType` (default "gui").
 */
function viewObjectViewTypes(object: string): Array<"gui" | "tui" | "xr"> {
  const modalitiesMatch = object.match(/modalities:\s*\[([^\]]*)\]/);
  if (modalitiesMatch) {
    const mods = [...modalitiesMatch[1].matchAll(/"(gui|tui|xr)"/g)].map(
      (match) => match[1] as "gui" | "tui" | "xr",
    );
    if (mods.length > 0) return mods;
  }
  const viewType = stringField(object, "viewType") ?? "gui";
  if (viewType !== "gui" && viewType !== "tui" && viewType !== "xr") return [];
  return [viewType];
}

function pluginViewCasesFromManifest(manifestPath: string): PluginViewCase[] {
  const source = readFileSync(path.resolve(REPO_ROOT, manifestPath), "utf8");
  return viewObjects(source).flatMap((object) => {
    const id = stringField(object, "id");
    const pathValue = stringField(object, "path");
    if (!id || !pathValue) return [];
    return viewObjectViewTypes(object).map((viewType) => ({
      manifestPath,
      id,
      viewType,
      path: pathValue,
    }));
  });
}

function discoverPluginViewManifestPaths(): string[] {
  const pluginRoot = path.resolve(REPO_ROOT, "plugins");
  const discovered: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(REPO_ROOT, fullPath);
      if (entry.isDirectory()) {
        if (
          ["dist", "node_modules", "coverage"].includes(entry.name) ||
          relativePath.includes(`${path.sep}test${path.sep}`) ||
          relativePath.includes(`${path.sep}__tests__${path.sep}`)
        ) {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (
        entry.name.endsWith(".d.ts") ||
        entry.name.includes(".test.") ||
        entry.name.includes(".spec.") ||
        entry.name === "vite.config.views.ts"
      ) {
        continue;
      }

      const source = readFileSync(fullPath, "utf8");
      if (!source.includes("views:") || !source.includes("componentExport:")) {
        continue;
      }
      if (viewObjects(source).length === 0) continue;
      discovered.push(relativePath.split(path.sep).join("/"));
    }
  };
  visit(pluginRoot);
  return sorted(discovered);
}

function appNavTabPathsFromManifest(manifestPath: string): string[] {
  const source = readFileSync(path.resolve(REPO_ROOT, manifestPath), "utf8");
  return arrayObjectChunks(source, "navTabs").flatMap((object) => {
    const pathValue = stringField(object, "path");
    return pathValue ? [pathValue] : [];
  });
}

function registeredAppShellPagePaths(): string[] {
  return APP_SHELL_REGISTRATION_SOURCES.flatMap((sourcePath) => [
    ...pathsFromSource(path.resolve(REPO_ROOT, sourcePath)),
  ]);
}

function pluginViewCasesFromVisualSpec(): PluginViewCase[] {
  const source = readFileSync(PLUGIN_VIEW_CASES_SOURCE, "utf8");
  return [
    ...source.matchAll(
      /\["([^"]+)",\s*"(gui|tui)",\s*"([^"]+)"(?:,\s*\{[^}\]]*\})?\]/g,
    ),
  ].map((match) => ({
    manifestPath: PLUGIN_VIEW_CASES_SOURCE,
    id: match[1] ?? "",
    viewType: (match[2] ?? "gui") as "gui" | "tui" | "xr",
    path: match[3] ?? "",
  }));
}

function pluginViewCaseKey(viewCase: Pick<PluginViewCase, "id" | "viewType">) {
  return `${viewCase.id}:${viewCase.viewType}`;
}

function pluginViewCaseFullKey(viewCase: PluginViewCase) {
  return `${viewCase.manifestPath}:${viewCase.id}:${viewCase.viewType}:${viewCase.path}`;
}

function appMainPluginIds(): string[] {
  const source = readFileSync(APP_MAIN_SOURCE, "utf8");
  return sorted(
    [
      ...source.matchAll(/cachedDynamicImport\(\s*"([^"]+)"/g),
      ...source.matchAll(/importSideEffectAppModule\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? ""),
  );
}

function appWindowRoutePaths(): string[] {
  const source = readFileSync(APP_MAIN_SOURCE, "utf8");
  return sorted(
    [...source.matchAll(/appWindowSlug === "([^"]+)"/g)].map(
      (match) => `/apps/${match[1] ?? ""}`,
    ),
  );
}

function sideEffectPluginIds(): string[] {
  // Manifest-driven: the side-effect loader list is generated at build time
  // from each plugin's `elizaos.appRegister` marker (no hardcoded list in
  // plugin-registrations.ts), so the ratchet reads the same scan the renderer
  // build uses, keyed by canonical package name.
  return sorted(
    discoverSideEffectAppModules([
      path.resolve(REPO_ROOT, "plugins"),
      path.resolve(REPO_ROOT, "packages"),
    ]).map((module) => module.key),
  );
}

function appPackageDependencies(): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(REPO_ROOT, "packages/app/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return packageJson.dependencies ?? {};
}

function packageNameForBootModule(moduleId: string): string {
  const scopedPackage = moduleId.match(/^(@[^/]+\/[^/]+)/);
  if (scopedPackage) return scopedPackage[1] ?? moduleId;
  return moduleId.replace(/\/register$/, "");
}

function internalToolWindowPaths(): string[] {
  const source = readFileSync(INTERNAL_TOOL_APPS_SOURCE, "utf8");
  // Each internal-tool ViewDeclaration carries its window path as `path:`,
  // always an `/apps/<tab>` route — parse those directly.
  return [...source.matchAll(/path:\s*"(\/apps\/[^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function unique<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Manager-visible gui views, keyed by id → declared path, parsed from the same
 * plugin manifests that feed GET /api/views. This is the static source of truth
 * for which tiles the View Manager renders.
 */
function managerVisibleGuiViewPaths(): Map<string, string> {
  const byId = new Map<string, string>();
  for (const manifestPath of PLUGIN_VIEW_MANIFESTS) {
    const source = readFileSync(path.resolve(REPO_ROOT, manifestPath), "utf8");
    for (const object of viewObjects(source)) {
      const id = stringField(object, "id");
      const pathValue = stringField(object, "path");
      const drawsGui = viewObjectViewTypes(object).includes("gui");
      const visibleInManager = /visibleInManager:\s*true/.test(object);
      if (!id || !pathValue || !drawsGui || !visibleInManager) {
        continue;
      }
      if (!byId.has(id)) byId.set(id, pathValue);
    }
  }
  return byId;
}

describe("app route coverage gate", () => {
  it("route smoke matrix covers catalog and app-window routes", () => {
    const smokePaths = new Set([
      ...pathsFromSource(ALL_PAGES_SPEC),
      ...DIRECT_ROUTE_CASES.map((routeCase) => routeCase.path),
    ]);
    if (smokePaths.has("/")) {
      smokePaths.add("/home");
    }
    const catalogPaths = unique(
      buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z")).routes.map(
        (route) => route.path,
      ),
    );
    const appWindowPaths = unique([
      ...DIRECT_ROUTE_CASES.map((routeCase) => routeCase.path),
      ...internalToolWindowPaths(),
      ...registeredAppShellPagePaths(),
      ...appWindowRoutePaths(),
      ...PLUGIN_VIEW_MANIFESTS.flatMap((manifestPath) =>
        appNavTabPathsFromManifest(manifestPath),
      ),
    ]);
    const expectedPaths = unique([...catalogPaths, ...appWindowPaths]);

    const missing = expectedPaths.filter(
      (pathValue) => !smokePaths.has(pathValue),
    );

    expect(
      missing,
      `Missing app all-pages route smoke coverage for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("manager-visible view tile matrix tracks every manager-visible gui view", () => {
    const managerViews = managerVisibleGuiViewPaths();
    const safeTileIds = new Set(
      MANAGER_VISIBLE_VIEW_TILE_CASES.map((tile) => tile.viewId),
    );
    const missingTiles = [...managerViews.keys()].filter(
      (viewId) => !safeTileIds.has(viewId),
    );

    expect(
      MANAGER_VISIBLE_VIEW_TILE_CASES.length,
      "MANAGER_VISIBLE_VIEW_TILE_CASES must not be empty",
    ).toBeGreaterThan(0);
    expect(
      missingTiles,
      "Every manager-visible gui view must have a View Manager tile case.",
    ).toEqual([]);

    for (const tile of MANAGER_VISIBLE_VIEW_TILE_CASES) {
      const viewPath = managerViews.get(tile.viewId);
      expect(
        viewPath,
        `Safe view tile "${tile.viewId}" must map to a manager-visible gui view in the plugin manifests`,
      ).toBeDefined();
      expect(
        tile.expectedPath,
        `Safe view tile "${tile.viewId}" expectedPath must match its manifest view path`,
      ).toBe(viewPath);
    }
  });

  it("discovers every production plugin view manifest in the manifest ratchet", () => {
    const discovered = discoverPluginViewManifestPaths();

    const missing = discovered.filter(
      (manifest) =>
        !(PLUGIN_VIEW_MANIFESTS as readonly string[]).includes(manifest),
    );
    const stale = PLUGIN_VIEW_MANIFESTS.filter(
      (manifest) => !discovered.includes(manifest),
    );

    expect(
      missing,
      `PLUGIN_VIEW_MANIFESTS is missing production plugin view manifests: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `PLUGIN_VIEW_MANIFESTS references files that no longer declare production plugin views: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("plugin views visual matrix covers every bundled gui/tui view", () => {
    const expectedCases = PLUGIN_VIEW_MANIFESTS.flatMap((manifestPath) =>
      pluginViewCasesFromManifest(manifestPath),
    ).filter((viewCase) => viewCase.viewType !== "xr");
    const visualCases = pluginViewCasesFromVisualSpec();
    const expectedByKey = new Map(
      expectedCases.map((viewCase) => [pluginViewCaseKey(viewCase), viewCase]),
    );
    const visualByKey = new Map(
      visualCases.map((viewCase) => [pluginViewCaseKey(viewCase), viewCase]),
    );

    const missing = expectedCases
      .filter((viewCase) => !visualByKey.has(pluginViewCaseKey(viewCase)))
      .map(
        (viewCase) =>
          `${viewCase.manifestPath}:${viewCase.id}:${viewCase.viewType}`,
      );
    const stale = visualCases
      .filter((viewCase) => !expectedByKey.has(pluginViewCaseKey(viewCase)))
      .map(
        (viewCase) => `${viewCase.id}:${viewCase.viewType}:${viewCase.path}`,
      );
    const pathMismatches = expectedCases
      .filter((viewCase) => {
        const visualCase = visualByKey.get(pluginViewCaseKey(viewCase));
        return visualCase && visualCase.path !== viewCase.path;
      })
      .map((viewCase) => {
        const visualCase = visualByKey.get(pluginViewCaseKey(viewCase));
        return `${viewCase.manifestPath}:${viewCase.id}:${viewCase.viewType} expected ${viewCase.path} got ${visualCase?.path}`;
      });

    expect(
      missing,
      `Missing plugin-views visual coverage for: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `Stale plugin-views visual coverage for removed/non-bundled views: ${stale.join(", ")}`,
    ).toEqual([]);
    expect(
      pathMismatches,
      `Plugin-views visual paths drifted from manifests: ${pathMismatches.join(", ")}`,
    ).toEqual([]);
  });

  it("operator plugin view manifests keep one collapsed gui/xr/tui contract", () => {
    const contractsByManifest = new Map<string, PluginViewManifestContract[]>();
    for (const contract of OPERATOR_VIEW_MANIFEST_CONTRACTS) {
      const contracts = contractsByManifest.get(contract.manifestPath) ?? [];
      contracts.push(contract);
      contractsByManifest.set(contract.manifestPath, contracts);
    }

    const failures = [...contractsByManifest].flatMap(
      ([manifestPath, contracts]) => {
        const source = readFileSync(
          path.resolve(REPO_ROOT, manifestPath),
          "utf8",
        );
        // One collapsed declaration per id (no longer one per viewType).
        const objectsById = new Map(
          viewObjects(source).map((object) => [
            stringField(object, "id") ?? "",
            object,
          ]),
        );

        return contracts.flatMap((contract) => {
          const object = objectsById.get(contract.id);
          if (!object) {
            return [`${manifestPath}:${contract.id} missing view declaration`];
          }
          const bundlePath = stringField(object, "bundlePath");
          const componentExport = stringField(object, "componentExport");
          const pathValue = stringField(object, "path");
          const modalities = viewObjectViewTypes(object);
          const missingModalities = contract.modalities.filter(
            (modality) => !modalities.includes(modality),
          );
          return [
            pathValue === contract.path
              ? null
              : `${manifestPath}:${contract.id} path expected ${contract.path} got ${pathValue}`,
            bundlePath === "dist/views/bundle.js"
              ? null
              : `${manifestPath}:${contract.id} bundle expected dist/views/bundle.js got ${bundlePath}`,
            componentExport === contract.componentExport
              ? null
              : `${manifestPath}:${contract.id} component expected ${contract.componentExport} got ${componentExport}`,
            missingModalities.length === 0
              ? null
              : `${manifestPath}:${contract.id} missing modalities ${missingModalities.join(",")}`,
          ].filter((failure): failure is string => Boolean(failure));
        });
      },
    );

    expect(
      failures,
      `Operator plugin view manifest contracts drifted: ${failures.join("; ")}`,
    ).toEqual([]);
  });

  it("tracked plugin view visual review report covers every visual matrix case", () => {
    const visualCases = pluginViewCasesFromVisualSpec();
    const report = readFileSync(PLUGIN_VIEW_VISUAL_REVIEW_REPORT, "utf8");
    const reportRows = [
      ...report.matchAll(
        /^\| `([^`]+)` \| `(gui|tui)` \| `([^`]+)` \| .+ \| .+ \| .+ \|$/gm,
      ),
    ].map((match) => ({
      id: match[1] ?? "",
      viewType: (match[2] ?? "gui") as "gui" | "tui" | "xr",
      path: match[3] ?? "",
      manifestPath: PLUGIN_VIEW_VISUAL_REVIEW_REPORT,
    }));
    const visualByKey = new Map(
      visualCases.map((viewCase) => [pluginViewCaseKey(viewCase), viewCase]),
    );
    const reportByKey = new Map(
      reportRows.map((viewCase) => [pluginViewCaseKey(viewCase), viewCase]),
    );

    const missing = visualCases
      .filter((viewCase) => !reportByKey.has(pluginViewCaseKey(viewCase)))
      .map(
        (viewCase) => `${viewCase.id}:${viewCase.viewType}:${viewCase.path}`,
      );
    const stale = reportRows
      .filter((viewCase) => !visualByKey.has(pluginViewCaseKey(viewCase)))
      .map(
        (viewCase) => `${viewCase.id}:${viewCase.viewType}:${viewCase.path}`,
      );
    const pathMismatches = visualCases
      .filter((viewCase) => {
        const reportCase = reportByKey.get(pluginViewCaseKey(viewCase));
        return reportCase && reportCase.path !== viewCase.path;
      })
      .map((viewCase) => {
        const reportCase = reportByKey.get(pluginViewCaseKey(viewCase));
        return `${viewCase.id}:${viewCase.viewType} expected ${viewCase.path} got ${reportCase?.path}`;
      });

    expect(
      missing,
      `Missing tracked visual-review rows for: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `Tracked visual-review report has stale rows: ${stale.join(", ")}`,
    ).toEqual([]);
    expect(
      pathMismatches,
      `Tracked visual-review report paths drifted: ${pathMismatches.join(", ")}`,
    ).toEqual([]);
  });

  it("plugin view manifest ratchet tracks bundled xr view declarations", () => {
    const actualCases = PLUGIN_VIEW_MANIFESTS.flatMap((manifestPath) =>
      pluginViewCasesFromManifest(manifestPath),
    ).filter((viewCase) => viewCase.viewType === "xr");
    const expectedByKey = new Map(
      KNOWN_XR_VIEW_CASES.map((viewCase) => [
        pluginViewCaseFullKey(viewCase),
        viewCase,
      ]),
    );
    const actualByKey = new Map(
      actualCases.map((viewCase) => [
        pluginViewCaseFullKey(viewCase),
        viewCase,
      ]),
    );

    const missing = KNOWN_XR_VIEW_CASES.filter(
      (viewCase) => !actualByKey.has(pluginViewCaseFullKey(viewCase)),
    ).map(pluginViewCaseFullKey);
    const stale = actualCases
      .filter((viewCase) => !expectedByKey.has(pluginViewCaseFullKey(viewCase)))
      .map(pluginViewCaseFullKey);

    expect(
      missing,
      `Bundled XR view declarations changed or disappeared: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `New bundled XR views need explicit runtime coverage classification: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("plugin view manifest ratchet tracks compiled app plugin loaders", () => {
    const bootPluginIds = unique([
      ...appMainPluginIds(),
      ...sideEffectPluginIds(),
    ]);
    const mappedIds = Object.keys(BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE);
    const missingMappings = bootPluginIds.filter(
      (id) => !(id in BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE),
    );
    const staleMappings = mappedIds.filter((id) => !bootPluginIds.includes(id));
    const manifests = new Set(PLUGIN_VIEW_MANIFESTS);
    const missingManifestCoverage = bootPluginIds.flatMap((id) => {
      const manifest = BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE[id];
      if (!manifest || manifests.has(manifest)) return [];
      return [`${id} -> ${manifest}`];
    });

    expect(
      missingMappings,
      `New compiled app plugin loaders need a view manifest classification: ${missingMappings.join(", ")}`,
    ).toEqual([]);
    expect(
      staleMappings,
      `Stale compiled app plugin loader mappings: ${staleMappings.join(", ")}`,
    ).toEqual([]);
    expect(
      missingManifestCoverage,
      `Boot plugin view manifests missing from PLUGIN_VIEW_MANIFESTS: ${missingManifestCoverage.join(", ")}`,
    ).toEqual([]);
  });

  it("compiled app plugin loaders have packaged workspace dependencies", () => {
    const dependencies = appPackageDependencies();
    const bootPluginIds = unique([
      ...appMainPluginIds(),
      ...sideEffectPluginIds(),
    ]);
    const missingDependencies = bootPluginIds
      .map(packageNameForBootModule)
      .filter((packageName) => packageName.startsWith("@elizaos/"))
      .filter((packageName) => dependencies[packageName] !== "workspace:*");

    expect(
      missingDependencies,
      `Boot-loaded app plugin modules must be declared in packages/app/package.json dependencies: ${missingDependencies.join(", ")}`,
    ).toEqual([]);
  });

  it("every plugin view manifest is app-boot mapped or explicitly classified", () => {
    const bootMappedManifests = new Set(
      Object.values(BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE).filter(
        (manifest): manifest is (typeof PLUGIN_VIEW_MANIFESTS)[number] =>
          typeof manifest === "string",
      ),
    );
    const allowlisted = new Set(
      Object.keys(NOT_APP_BOOT_LOADED_VIEW_MANIFESTS),
    );

    const unclassified = PLUGIN_VIEW_MANIFESTS.filter(
      (manifest) =>
        !bootMappedManifests.has(manifest) && !allowlisted.has(manifest),
    );
    const staleAllowlist = [...allowlisted].filter(
      (manifest) =>
        !(PLUGIN_VIEW_MANIFESTS as readonly string[]).includes(manifest),
    );
    const mappedAllowlist = [...allowlisted].filter((manifest) =>
      bootMappedManifests.has(manifest),
    );
    const missingReasons = [...allowlisted].filter(
      (manifest) => !NOT_APP_BOOT_LOADED_VIEW_MANIFESTS[manifest]?.trim(),
    );

    expect(
      unclassified,
      `Plugin view manifests must be app-boot mapped or explicitly classified: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(
      staleAllowlist,
      `NOT_APP_BOOT_LOADED_VIEW_MANIFESTS references removed manifests: ${staleAllowlist.join(", ")}`,
    ).toEqual([]);
    expect(
      mappedAllowlist,
      `Remove app-boot mapped manifests from NOT_APP_BOOT_LOADED_VIEW_MANIFESTS: ${mappedAllowlist.join(", ")}`,
    ).toEqual([]);
    expect(
      missingReasons,
      `Every non-app-boot-loaded manifest classification needs a reason: ${missingReasons.join(", ")}`,
    ).toEqual([]);
  });
});
