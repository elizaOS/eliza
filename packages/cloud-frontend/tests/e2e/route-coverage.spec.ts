import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "../..");
const SRC_ROOT = path.join(PACKAGE_ROOT, "src");
const APP_SOURCE = path.join(SRC_ROOT, "App.tsx");

function walkPageComponents(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkPageComponents(fullPath));
      continue;
    }
    if (entry === "page.tsx" || entry === "Page.tsx") {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function toAppImportPath(filePath: string): string {
  return `./${path
    .relative(SRC_ROOT, filePath)
    .replace(/\\/g, "/")
    .replace(/\.tsx$/, "")}`;
}

function lazyRouteImports(appSource: string): Set<string> {
  return new Set(
    [
      ...appSource.matchAll(
        /lazyWithPreload\(\s*\(\)\s*=>\s*import\("([^"]+)"\)/g,
      ),
    ]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
}

test("every cloud page component is reachable from the router", async () => {
  const appSource = readFileSync(APP_SOURCE, "utf8");
  const routeImports = lazyRouteImports(appSource);
  const pageComponents = [
    ...walkPageComponents(path.join(SRC_ROOT, "pages")),
    ...walkPageComponents(path.join(SRC_ROOT, "dashboard")),
  ];

  const missing = pageComponents
    .map((filePath) => ({
      filePath: path.relative(PACKAGE_ROOT, filePath),
      importPath: toAppImportPath(filePath),
    }))
    .filter(({ importPath }) => !routeImports.has(importPath));

  expect(
    missing,
    `These page components are not lazy-loaded by src/App.tsx:\n${missing
      .map(({ filePath, importPath }) => `  - ${filePath} (${importPath})`)
      .join("\n")}`,
  ).toEqual([]);
});
