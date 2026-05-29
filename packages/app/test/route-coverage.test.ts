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
const ALL_PAGES_SPEC = path.join(HERE, "ui-smoke", "all-pages-clicksafe.spec.ts");
const INTERNAL_TOOL_APPS_SOURCE = path.resolve(
  HERE,
  "../../ui/src/components/apps/internal-tool-apps.ts",
);

function pathsFromSource(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
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
});
