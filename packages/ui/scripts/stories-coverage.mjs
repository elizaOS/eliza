#!/usr/bin/env node
// Story coverage: for every .tsx in packages/ui/src/components/ that defines
// a React component, check if a sibling *.stories.tsx exists.
//
// Output: markdown report + JSON.
// Usage: bun run scripts/stories-coverage.mjs [--all]
//   --all   include non-/components/ files (chat, apps, etc.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const componentsRoot = path.resolve(pkgRoot, "src/components");

const args = process.argv.slice(2);
const onlyComponents = !args.includes("--all");

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === "__e2e__")
      continue;
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
      !e.name.endsWith(".hooks.tsx")
    )
      yield full;
  }
}

const root = onlyComponents
  ? componentsRoot
  : path.resolve(pkgRoot, "src");

const files = [...walk(root)];

const hasComponent = (src) => {
  // Must export a PascalCase function/const/class component AND contain JSX.
  const hasExport =
    /\bexport\s+(?:default\s+)?(?:function|class)\s+[A-Z]/.test(src) ||
    /\bexport\s+(?:default\s+)?(?:const|let|var)\s+[A-Z]\w+\s*[:=]/.test(src);
  const hasJsx = /<\/?[A-Z]\w/.test(src) || /=>\s*</.test(src) || /return\s*\(\s*</.test(src);
  return hasExport && hasJsx;
};

const componentFiles = [];
for (const f of files) {
  let src;
  try {
    src = fs.readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (!hasComponent(src)) continue;
  componentFiles.push(f);
}

const missing = [];
const present = [];
for (const f of componentFiles) {
  const stories = f.replace(/\.tsx$/, ".stories.tsx");
  if (fs.existsSync(stories)) {
    present.push(path.relative(pkgRoot, f));
  } else {
    missing.push(path.relative(pkgRoot, f));
  }
}

missing.sort();
present.sort();

const report = {
  componentFiles: componentFiles.length,
  withStories: present.length,
  missingStories: missing.length,
  coverage: ((present.length / componentFiles.length) * 100).toFixed(1) + "%",
  missing,
  present,
};

// Group missing by top-level directory
const byDir = new Map();
for (const m of missing) {
  const segments = m.replace(/\\/g, "/").split("/");
  // segments[0]='src', segments[1]='components', segments[2]=area
  const area = segments[2] || segments[1] || "root";
  if (!byDir.has(area)) byDir.set(area, []);
  byDir.get(area).push(m);
}

const lines = [];
lines.push(`# Story coverage`);
lines.push("");
lines.push(`- Components scanned: **${componentFiles.length}**`);
lines.push(`- With stories: **${present.length}**`);
lines.push(`- Missing stories: **${missing.length}**`);
lines.push(`- Coverage: **${report.coverage}**`);
lines.push("");
lines.push(`## Missing stories by area`);
for (const [area, list] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`\n### ${area} (${list.length})`);
  for (const f of list) lines.push(`- ${f}`);
}

fs.writeFileSync(
  path.join(here, "stories-coverage-report.json"),
  JSON.stringify(report, null, 2),
);
fs.writeFileSync(path.join(here, "stories-coverage-report.md"), lines.join("\n"));

console.log(`Components: ${componentFiles.length}`);
console.log(`With stories: ${present.length}`);
console.log(`Missing: ${missing.length}`);
console.log(`Coverage: ${report.coverage}`);
console.log(`\nWrote: scripts/stories-coverage-report.json`);
console.log(`Wrote: scripts/stories-coverage-report.md`);
