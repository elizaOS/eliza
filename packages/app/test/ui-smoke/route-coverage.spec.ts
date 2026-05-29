import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildRouteCatalog } from "../../../app-core/src/api/dev-route-catalog";
import { shouldShowAppInAppsView } from "../../../ui/src/components/apps/helpers";
import { getInternalToolAppDescriptors } from "../../../ui/src/components/apps/internal-tool-apps";
import {
  DIRECT_ROUTE_CASES,
  SAFE_APP_TILE_CASES,
} from "./apps-session-route-cases";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL_PAGES_SPEC = path.join(HERE, "all-pages-clicksafe.spec.ts");
const INTERNAL_TOOL_APPS_SOURCE = path.resolve(
  HERE,
  "../../../ui/src/components/apps/internal-tool-apps.ts",
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

function defaultVisibleInternalToolAppNames(): string[] {
  return getInternalToolAppDescriptors()
    .filter((app) => app.windowPath)
    .filter((app) =>
      shouldShowAppInAppsView(
        {
          name: app.name,
          category: "utility",
        },
        {
          isProd: false,
          showAllApps: false,
          walletEnabled: false,
        },
      ),
    )
    .map((app) => app.name);
}

test("app route smoke matrix covers catalog and app-window routes", () => {
  const smokePaths = new Set([
    ...pathsFromSource(ALL_PAGES_SPEC),
    ...DIRECT_ROUTE_CASES.map((routeCase) => routeCase.path),
  ]);
  if (smokePaths.has("/")) {
    smokePaths.add("/home");
  }
  const catalogPaths = buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z"))
    .routes.map((route) => route.path)
    .filter((pathValue, index, paths) => paths.indexOf(pathValue) === index);
  const appWindowPaths = [
    ...DIRECT_ROUTE_CASES.map((routeCase) => routeCase.path),
    ...internalToolWindowPaths(),
  ].filter((pathValue, index, paths) => paths.indexOf(pathValue) === index);
  const expectedPaths = [...catalogPaths, ...appWindowPaths].filter(
    (pathValue, index, paths) => paths.indexOf(pathValue) === index,
  );

  const missing = expectedPaths.filter(
    (pathValue) => !smokePaths.has(pathValue),
  );

  expect(
    missing,
    `Missing app all-pages route smoke coverage for: ${missing.join(", ")}`,
  ).toEqual([]);
});

test("app tile smoke matrix covers default visible app catalog routes", () => {
  const expectedAppNames = [
    ...defaultVisibleInternalToolAppNames(),
    "@elizaos/plugin-companion",
  ].filter((appName, index, appNames) => appNames.indexOf(appName) === index);
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
