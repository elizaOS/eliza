/**
 * Static route-matrix coverage guard for homepage live and visual Playwright specs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "../..");
const APP_SOURCE = path.join(PACKAGE_ROOT, "src/App.tsx");
const LIVE_ROUTES_SPEC = path.join(HERE, "live-routes.spec.ts");
const VISUAL_SPEC = path.join(HERE, "visual.spec.ts");

function routePathsFromApp(): string[] {
  const source = readFileSync(APP_SOURCE, "utf8");
  return [...source.matchAll(/<Route\s+path="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function routePathsFromSpec(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

test("homepage route matrices cover every routed page", () => {
  const appRoutes = routePathsFromApp();
  const liveRoutes = routePathsFromSpec(LIVE_ROUTES_SPEC);
  const visualRoutes = routePathsFromSpec(VISUAL_SPEC);

  expect(appRoutes).toEqual([
    "/",
    "/leaderboard",
    "/login",
    "/connected",
    "/get-started",
  ]);

  const missingLiveRoutes = appRoutes.filter((route) => !liveRoutes.has(route));
  const missingVisualRoutes = appRoutes.filter(
    (route) => !visualRoutes.has(route),
  );

  expect(
    missingLiveRoutes,
    `Missing homepage live route coverage for: ${missingLiveRoutes.join(", ")}`,
  ).toEqual([]);
  expect(
    missingVisualRoutes,
    `Missing homepage visual route coverage for: ${missingVisualRoutes.join(", ")}`,
  ).toEqual([]);
});
