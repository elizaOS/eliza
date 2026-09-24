#!/usr/bin/env node
/** Reports current story coverage without snapshots, quotas, or generated source artifacts. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const componentsRoot = path.resolve(pkgRoot, "src/components");

function extractLocalStoryImports(source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith(".")) imports.push(match[1]);
  }
  return imports;
}

function resolveLocalStoryImport(storyFile, specifier, fileExists) {
  const base = path.resolve(path.dirname(storyFile), specifier);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name === "node_modules" ||
      e.name === "__tests__" ||
      e.name === "__e2e__"
    )
      continue;
    // Storybook harness + story fixtures are not user-facing components.
    if (e.name === "storybook" || e.name === "stories") continue;
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (
      e.isFile() &&
      e.name.endsWith(".tsx") &&
      !e.name.endsWith(".stories.tsx") &&
      !e.name.endsWith(".test.tsx") &&
      !e.name.endsWith(".spec.tsx") &&
      !e.name.endsWith(".helpers.tsx") &&
      !e.name.endsWith(".hooks.tsx") &&
      !e.name.endsWith("Provider.tsx") &&
      !e.name.endsWith("Context.tsx")
    )
      yield full;
  }
}

function* walkStoryFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkStoryFiles(full);
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".stories.tsx") ||
        entry.name.endsWith(".stories.ts"))
    ) {
      yield full;
    }
  }
}

/** Count authored components and their sibling or explicitly imported stories. */
export function buildStoryCoverage({ all = false } = {}) {
  const root = all ? path.resolve(pkgRoot, "src") : componentsRoot;

  const files = [...walk(root)];

  const hasComponent = (src) => {
    // Must export a PascalCase function/const/class component AND contain JSX.
    const hasExport =
      /\bexport\s+(?:default\s+)?(?:function|class)\s+[A-Z]/.test(src) ||
      /\bexport\s+(?:default\s+)?(?:const|let|var)\s+[A-Z]\w+\s*[:=]/.test(src);
    const hasJsx =
      /<\/?[A-Z]\w/.test(src) ||
      /=>\s*</.test(src) ||
      /return\s*\(\s*</.test(src);
    return hasExport && hasJsx;
  };

  const componentFiles = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!hasComponent(src)) continue;
    componentFiles.push(f);
  }

  const storyImports = new Set();
  for (const storyRoot of [
    path.resolve(pkgRoot, "src"),
    path.resolve(pkgRoot, "stories"),
  ]) {
    for (const storyFile of walkStoryFiles(storyRoot)) {
      const source = fs.readFileSync(storyFile, "utf8");
      for (const specifier of extractLocalStoryImports(source)) {
        const resolved = resolveLocalStoryImport(
          storyFile,
          specifier,
          fs.existsSync,
        );
        if (resolved) storyImports.add(path.normalize(resolved));
      }
    }
  }

  const missing = [];
  const present = [];
  for (const f of componentFiles) {
    const stories = f.replace(/\.tsx$/, ".stories.tsx");
    if (fs.existsSync(stories) || storyImports.has(path.normalize(f))) {
      present.push(path.relative(pkgRoot, f));
    } else {
      missing.push(path.relative(pkgRoot, f));
    }
  }

  missing.sort();
  present.sort();

  return {
    componentFiles: componentFiles.length,
    withStories: present.length,
    missingStories: missing.length,
    coverage: `${(componentFiles.length === 0 ? 0 : (present.length / componentFiles.length) * 100).toFixed(1)}%`,
    missing,
    present,
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--all", "--json"].includes(arg))) {
    throw new Error(
      "Usage: node scripts/stories-coverage.mjs [--all] [--json]",
    );
  }
  const report = buildStoryCoverage({ all: args.includes("--all") });
  process.stdout.write(
    args.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Components: ${report.componentFiles}\nWith stories: ${report.withStories}\nMissing: ${report.missingStories}\nCoverage: ${report.coverage}\n`,
  );
}
