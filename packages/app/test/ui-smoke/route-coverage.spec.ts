import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildRouteCatalog } from "../../../app-core/src/api/dev-route-catalog";
import { DIRECT_ROUTE_CASES } from "./apps-session-route-cases";

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

test("app route smoke matrix covers catalog and app-window routes", () => {
  const smokePaths = new Set([
    ...pathsFromSource(ALL_PAGES_SPEC),
    ...DIRECT_ROUTE_CASES.map((routeCase) => routeCase.path),
  ]);
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
