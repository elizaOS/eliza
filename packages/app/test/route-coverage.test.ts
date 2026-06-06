import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRouteCatalog } from "../../app-core/src/api/dev-route-catalog";
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
const SIDE_EFFECT_PLUGIN_SOURCE = path.resolve(
  HERE,
  "../src/plugin-registrations.ts",
);

type PluginViewCase = {
  manifestPath: string;
  id: string;
  viewType: "gui" | "tui" | "xr";
  path: string;
};

type PluginViewManifestContract = PluginViewCase & {
  componentExport: string;
};

const PLUGIN_VIEW_MANIFESTS = [
  "plugins/plugin-companion/src/plugin.ts",
  "plugins/plugin-contacts/src/plugin.ts",
  "plugins/plugin-hyperliquid-app/src/plugin.ts",
  "plugins/plugin-lifeops/src/plugin.ts",
  "plugins/plugin-messages/src/plugin.ts",
  "plugins/app-model-tester/src/plugin.ts",
  "plugins/plugin-phone/src/plugin.ts",
  "plugins/plugin-polymarket-app/src/plugin.ts",
  "plugins/plugin-shopify-ui/src/plugin.ts",
  "plugins/plugin-steward-app/src/plugin.ts",
  "plugins/plugin-vincent/src/plugin.ts",
  "plugins/plugin-wallet-ui/src/plugin.ts",
  "plugins/plugin-vector-browser/src/plugin.ts",
  "plugins/plugin-2004scape/src/index.ts",
  "plugins/plugin-feed/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-clawville/src/index.ts",
  "plugins/plugin-defense-of-the-agents/src/index.ts",
  "plugins/plugin-hyperscape/src/index.ts",
  "plugins/plugin-scape/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-social-alpha/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/index.ts",
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
  "plugins/plugin-app-control/src/index.ts":
    "View manager routes are built into the app shell and tested through /views; this plugin supplies agent actions plus the manager view declaration.",
  "plugins/plugin-screenshare/src/index.ts":
    "Screenshare is registered by runtime capability loading, not the app boot side-effect loader.",
  "plugins/plugin-social-alpha/src/index.ts":
    "Social Alpha is opt-in and loaded by benchmark/runtime configuration rather than the app boot side-effect loader.",
};

const BOOT_PLUGIN_VIEW_MANIFEST_BY_MODULE: Record<string, string | null> = {
  "@elizaos/app-core": null,
  "@elizaos/plugin-2004scape": "plugins/plugin-2004scape/src/index.ts",
  "@elizaos/plugin-clawville": "plugins/plugin-clawville/src/index.ts",
  "@elizaos/plugin-companion": "plugins/plugin-companion/src/plugin.ts",
  "@elizaos/plugin-contacts/register": "plugins/plugin-contacts/src/plugin.ts",
  "@elizaos/plugin-defense-of-the-agents":
    "plugins/plugin-defense-of-the-agents/src/index.ts",
  "@elizaos/plugin-device-settings/register": null,
  "@elizaos/plugin-facewear/register": "plugins/plugin-facewear/src/index.ts",
  "@elizaos/plugin-feed": "plugins/plugin-feed/src/index.ts",
  "@elizaos/plugin-hyperliquid-app":
    "plugins/plugin-hyperliquid-app/src/plugin.ts",
  "@elizaos/plugin-hyperscape": "plugins/plugin-hyperscape/src/index.ts",
  "@elizaos/plugin-lifeops": "plugins/plugin-lifeops/src/plugin.ts",
  "@elizaos/plugin-messages/register": "plugins/plugin-messages/src/plugin.ts",
  "@elizaos/plugin-phone": "plugins/plugin-phone/src/plugin.ts",
  "@elizaos/plugin-phone/register": "plugins/plugin-phone/src/plugin.ts",
  "@elizaos/plugin-polymarket-app":
    "plugins/plugin-polymarket-app/src/plugin.ts",
  "@elizaos/plugin-scape": "plugins/plugin-scape/src/index.ts",
  "@elizaos/plugin-shopify-ui": "plugins/plugin-shopify-ui/src/plugin.ts",
  "@elizaos/plugin-steward-app": "plugins/plugin-steward-app/src/plugin.ts",
  "@elizaos/plugin-task-coordinator":
    "plugins/plugin-task-coordinator/src/index.ts",
  "@elizaos/plugin-task-coordinator/register":
    "plugins/plugin-task-coordinator/src/index.ts",
  "@elizaos/plugin-training": "plugins/plugin-training/src/setup-routes.ts",
  "@elizaos/plugin-trajectory-logger":
    "plugins/plugin-trajectory-logger/src/index.ts",
  "@elizaos/plugin-vector-browser/register":
    "plugins/plugin-vector-browser/src/plugin.ts",
  "@elizaos/plugin-vincent": "plugins/plugin-vincent/src/plugin.ts",
  "@elizaos/plugin-wallet-ui": "plugins/plugin-wallet-ui/src/plugin.ts",
  "@elizaos/plugin-wifi/register": null,
  "@elizaos/app-model-tester": "plugins/app-model-tester/src/plugin.ts",
};

const KNOWN_XR_VIEW_CASES: readonly PluginViewCase[] = [
  {
    manifestPath: "plugins/plugin-companion/src/plugin.ts",
    id: "companion",
    viewType: "xr",
    path: "/companion",
  },
  {
    manifestPath: "plugins/plugin-contacts/src/plugin.ts",
    id: "contacts",
    viewType: "xr",
    path: "/contacts",
  },
  {
    manifestPath: "plugins/plugin-hyperliquid-app/src/plugin.ts",
    id: "hyperliquid",
    viewType: "xr",
    path: "/hyperliquid",
  },
  {
    manifestPath: "plugins/plugin-lifeops/src/plugin.ts",
    id: "lifeops",
    viewType: "xr",
    path: "/lifeops",
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
    manifestPath: "plugins/plugin-polymarket-app/src/plugin.ts",
    id: "polymarket",
    viewType: "xr",
    path: "/polymarket",
  },
  {
    manifestPath: "plugins/plugin-shopify-ui/src/plugin.ts",
    id: "shopify",
    viewType: "xr",
    path: "/shopify",
  },
  {
    manifestPath: "plugins/plugin-steward-app/src/plugin.ts",
    id: "steward",
    viewType: "xr",
    path: "/steward",
  },
  {
    manifestPath: "plugins/plugin-vincent/src/plugin.ts",
    id: "vincent",
    viewType: "xr",
    path: "/vincent",
  },
  {
    manifestPath: "plugins/plugin-wallet-ui/src/plugin.ts",
    id: "wallet",
    viewType: "xr",
    path: "/wallet",
  },
  {
    manifestPath: "plugins/plugin-2004scape/src/index.ts",
    id: "2004scape",
    viewType: "xr",
    path: "/2004scape",
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
    manifestPath: "plugins/plugin-clawville/src/index.ts",
    id: "clawville",
    viewType: "xr",
    path: "/clawville",
  },
  {
    manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
    id: "defense-of-the-agents",
    viewType: "xr",
    path: "/defense-of-the-agents",
  },
  {
    manifestPath: "plugins/plugin-hyperscape/src/index.ts",
    id: "hyperscape",
    viewType: "xr",
    path: "/hyperscape",
  },
  {
    manifestPath: "plugins/plugin-scape/src/index.ts",
    id: "scape",
    viewType: "xr",
    path: "/scape",
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
    manifestPath: "plugins/plugin-trajectory-logger/src/index.ts",
    id: "trajectory-logger",
    viewType: "xr",
    path: "/trajectory-logger",
  },
  {
    manifestPath: "plugins/plugin-training/src/setup-routes.ts",
    id: "training",
    viewType: "xr",
    path: "/training",
  },
  {
    manifestPath: "plugins/plugin-facewear/src/index.ts",
    id: "facewear",
    viewType: "xr",
    path: "/apps/hearwear/xr",
  },
  {
    manifestPath: "plugins/plugin-facewear/src/index.ts",
    id: "smartglasses",
    viewType: "xr",
    path: "/apps/smartglasses/xr",
  },
];

const OPERATOR_VIEW_MANIFEST_CONTRACTS: readonly PluginViewManifestContract[] =
  [
    {
      manifestPath: "plugins/plugin-2004scape/src/index.ts",
      id: "2004scape",
      viewType: "gui",
      path: "/2004scape",
      componentExport: "TwoThousandFourScapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-2004scape/src/index.ts",
      id: "2004scape",
      viewType: "xr",
      path: "/2004scape",
      componentExport: "TwoThousandFourScapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-2004scape/src/index.ts",
      id: "2004scape",
      viewType: "tui",
      path: "/2004scape/tui",
      componentExport: "TwoThousandFourScapeTuiView",
    },
    {
      manifestPath: "plugins/plugin-clawville/src/index.ts",
      id: "clawville",
      viewType: "gui",
      path: "/clawville",
      componentExport: "ClawvilleOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-clawville/src/index.ts",
      id: "clawville",
      viewType: "xr",
      path: "/clawville",
      componentExport: "ClawvilleOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-clawville/src/index.ts",
      id: "clawville",
      viewType: "tui",
      path: "/clawville/tui",
      componentExport: "ClawvilleTuiView",
    },
    {
      manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
      id: "defense-of-the-agents",
      viewType: "gui",
      path: "/defense-of-the-agents",
      componentExport: "DefenseAgentsOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
      id: "defense-of-the-agents",
      viewType: "xr",
      path: "/defense-of-the-agents",
      componentExport: "DefenseAgentsOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
      id: "defense-of-the-agents",
      viewType: "tui",
      path: "/defense-of-the-agents/tui",
      componentExport: "DefenseAgentsTuiView",
    },
    {
      manifestPath: "plugins/plugin-feed/src/index.ts",
      id: "feed",
      viewType: "gui",
      path: "/feed",
      componentExport: "FeedOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-feed/src/index.ts",
      id: "feed",
      viewType: "xr",
      path: "/feed",
      componentExport: "FeedOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-feed/src/index.ts",
      id: "feed",
      viewType: "tui",
      path: "/feed/tui",
      componentExport: "FeedTuiView",
    },
    {
      manifestPath: "plugins/plugin-hyperscape/src/index.ts",
      id: "hyperscape",
      viewType: "gui",
      path: "/hyperscape",
      componentExport: "HyperscapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-hyperscape/src/index.ts",
      id: "hyperscape",
      viewType: "xr",
      path: "/hyperscape",
      componentExport: "HyperscapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-hyperscape/src/index.ts",
      id: "hyperscape",
      viewType: "tui",
      path: "/hyperscape/tui",
      componentExport: "HyperscapeTuiView",
    },
    {
      manifestPath: "plugins/plugin-scape/src/index.ts",
      id: "scape",
      viewType: "gui",
      path: "/scape",
      componentExport: "ScapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-scape/src/index.ts",
      id: "scape",
      viewType: "xr",
      path: "/scape",
      componentExport: "ScapeOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-scape/src/index.ts",
      id: "scape",
      viewType: "tui",
      path: "/scape/tui",
      componentExport: "ScapeTuiView",
    },
    {
      manifestPath: "plugins/plugin-screenshare/src/index.ts",
      id: "screenshare",
      viewType: "gui",
      path: "/screenshare",
      componentExport: "ScreenshareOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-screenshare/src/index.ts",
      id: "screenshare",
      viewType: "xr",
      path: "/screenshare",
      componentExport: "ScreenshareOperatorSurface",
    },
    {
      manifestPath: "plugins/plugin-screenshare/src/index.ts",
      id: "screenshare",
      viewType: "tui",
      path: "/screenshare/tui",
      componentExport: "ScreenshareTuiView",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "task-coordinator",
      viewType: "gui",
      path: "/task-coordinator",
      componentExport: "CodingAgentTasksPanel",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "task-coordinator",
      viewType: "xr",
      path: "/task-coordinator",
      componentExport: "CodingAgentTasksPanel",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "task-coordinator",
      viewType: "tui",
      path: "/task-coordinator/tui",
      componentExport: "TaskCoordinatorTuiView",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "orchestrator",
      viewType: "gui",
      path: "/orchestrator",
      componentExport: "OrchestratorWorkbench",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "orchestrator",
      viewType: "xr",
      path: "/orchestrator",
      componentExport: "OrchestratorWorkbench",
    },
    {
      manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
      id: "orchestrator",
      viewType: "tui",
      path: "/orchestrator/tui",
      componentExport: "OrchestratorTuiView",
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

function pluginViewCasesFromManifest(manifestPath: string): PluginViewCase[] {
  const source = readFileSync(path.resolve(REPO_ROOT, manifestPath), "utf8");
  return viewObjects(source).flatMap((object) => {
    const id = stringField(object, "id");
    const pathValue = stringField(object, "path");
    const viewType = stringField(object, "viewType") ?? "gui";
    if (!id || !pathValue) return [];
    if (viewType !== "gui" && viewType !== "tui" && viewType !== "xr") {
      return [];
    }
    return [{ manifestPath, id, viewType, path: pathValue }];
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
  const source = readFileSync(SIDE_EFFECT_PLUGIN_SOURCE, "utf8");
  return sorted(
    [...source.matchAll(/key:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

function appPackageDependencies(): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(REPO_ROOT, "packages/app/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return packageJson.dependencies ?? {};
}

function packageNameForBootModule(moduleId: string): string {
  return moduleId.replace(/\/register$/, "");
}

function internalToolWindowPaths(): string[] {
  const source = readFileSync(INTERNAL_TOOL_APPS_SOURCE, "utf8");
  return [...source.matchAll(/windowPath:\s*"([^"]+)"/g)].map(
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
      const viewType = stringField(object, "viewType") ?? "gui";
      const visibleInManager = /visibleInManager:\s*true/.test(object);
      if (!id || !pathValue || viewType !== "gui" || !visibleInManager) {
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

  it("operator plugin view manifests keep explicit gui/xr/tui contracts", () => {
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
        const objectsByKey = new Map(
          viewObjects(source).map((object) => {
            const id = stringField(object, "id") ?? "";
            const viewType = stringField(object, "viewType") ?? "gui";
            return [`${id}:${viewType}`, object];
          }),
        );

        return contracts.flatMap((contract) => {
          const object = objectsByKey.get(
            `${contract.id}:${contract.viewType}`,
          );
          if (!object) {
            return [
              `${manifestPath}:${contract.id}:${contract.viewType} missing view declaration`,
            ];
          }
          const bundlePath = stringField(object, "bundlePath");
          const componentExport = stringField(object, "componentExport");
          const pathValue = stringField(object, "path");
          return [
            pathValue === contract.path
              ? null
              : `${manifestPath}:${contract.id}:${contract.viewType} path expected ${contract.path} got ${pathValue}`,
            bundlePath === "dist/views/bundle.js"
              ? null
              : `${manifestPath}:${contract.id}:${contract.viewType} bundle expected dist/views/bundle.js got ${bundlePath}`,
            componentExport === contract.componentExport
              ? null
              : `${manifestPath}:${contract.id}:${contract.viewType} component expected ${contract.componentExport} got ${componentExport}`,
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
