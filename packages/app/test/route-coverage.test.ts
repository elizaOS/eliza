import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRouteCatalog } from "../../app-core/src/api/dev-route-catalog";
import { shouldShowAppInAppsView } from "../../ui/src/components/apps/helpers";
import { getInternalToolAppDescriptors } from "../../ui/src/components/apps/internal-tool-apps";
import {
  DIRECT_ROUTE_CASES,
  SAFE_APP_TILE_CASES,
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
const ALL_PAGES_SPEC = path.join(HERE, "ui-smoke", "all-pages-clicksafe.spec.ts");
const PLUGIN_VIEWS_SPEC = path.join(
  HERE,
  "ui-smoke",
  "plugin-views-visual.spec.ts",
);
const INTERNAL_TOOL_APPS_SOURCE = path.resolve(
  HERE,
  "../../ui/src/components/apps/internal-tool-apps.ts",
);

type PluginViewCase = {
  manifestPath: string;
  id: string;
  viewType: "gui" | "tui";
  path: string;
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
  "plugins/plugin-2004scape/src/index.ts",
  "plugins/plugin-feed/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-clawville/src/index.ts",
  "plugins/plugin-defense-of-the-agents/src/index.ts",
  "plugins/plugin-hyperscape/src/index.ts",
  "plugins/plugin-scape/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/index.ts",
  "plugins/plugin-training/src/setup-routes.ts",
  "plugins/plugin-facewear/src/index.ts",
] as const;

function pathsFromSource(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

function viewObjects(source: string): string[] {
  const viewsStart = source.indexOf("views:");
  if (viewsStart === -1) return [];
  const arrayStart = source.indexOf("[", viewsStart);
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

  const viewsSource = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let objectStart = -1;
  depth = 0;
  for (let index = 0; index < viewsSource.length; index += 1) {
    const char = viewsSource[index];
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(viewsSource.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }

  return objects.filter(
    (chunk) => chunk.includes("id:") && chunk.includes("componentExport:"),
  );
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
    if (viewType !== "gui" && viewType !== "tui") return [];
    return [{ manifestPath, id, viewType, path: pathValue }];
  });
}

function pluginViewCasesFromVisualSpec(): PluginViewCase[] {
  const source = readFileSync(PLUGIN_VIEWS_SPEC, "utf8");
  return [...source.matchAll(/\["([^"]+)",\s*"(gui|tui)",\s*"([^"]+)"\]/g)].map(
    (match) => ({
      manifestPath: PLUGIN_VIEWS_SPEC,
      id: match[1] ?? "",
      viewType: (match[2] ?? "gui") as "gui" | "tui",
      path: match[3] ?? "",
    }),
  );
}

function pluginViewCaseKey(viewCase: Pick<PluginViewCase, "id" | "viewType">) {
  return `${viewCase.id}:${viewCase.viewType}`;
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

function defaultVisibleInternalToolAppNames(): string[] {
  return getInternalToolAppDescriptors()
    .filter((app) => app.windowPath)
    .filter((app) =>
      shouldShowAppInAppsView(
        { name: app.name, category: "utility" },
        { isProd: false, showAllApps: false, walletEnabled: false },
      ),
    )
    .map((app) => app.name);
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

  it("app tile smoke matrix covers default visible app catalog routes", () => {
    const expectedAppNames = unique([
      ...defaultVisibleInternalToolAppNames(),
      "@elizaos/plugin-companion",
    ]);
    const tileAppNames = SAFE_APP_TILE_CASES.map((tileCase) => tileCase.appName);
    const directRouteTileAppNames = DIRECT_ROUTE_CASES.flatMap((routeCase) =>
      routeCase.catalogAppName ? [routeCase.catalogAppName] : [],
    );

    const missing = expectedAppNames.filter(
      (appName) => !tileAppNames.includes(appName),
    );
    const stale = tileAppNames.filter(
      (appName) => !expectedAppNames.includes(appName),
    );

    expect(
      SAFE_APP_TILE_CASES.length,
      "SAFE_APP_TILE_CASES must be generated from visible catalog route cases, not left empty",
    ).toBeGreaterThan(0);
    expect(
      missing,
      `Missing click-safe app tile coverage for: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `Stale click-safe app tile coverage for hidden/non-default apps: ${stale.join(", ")}`,
    ).toEqual([]);
    expect(
      tileAppNames,
      "SAFE_APP_TILE_CASES should stay generated from DIRECT_ROUTE_CASES catalogAppName metadata",
    ).toEqual(directRouteTileAppNames);
  });

  it("plugin views visual matrix covers every bundled gui/tui view", () => {
    const expectedCases = PLUGIN_VIEW_MANIFESTS.flatMap((manifestPath) =>
      pluginViewCasesFromManifest(manifestPath),
    );
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
      .map((viewCase) => `${viewCase.id}:${viewCase.viewType}:${viewCase.path}`);
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
});
