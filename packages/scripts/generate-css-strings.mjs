#!/usr/bin/env node
/**
 * Generate `*.css.ts` modules from sibling `*.css` files for components that
 * inject styles at runtime via a `<style>` tag.
 *
 * Why this exists: components like `VoicePill` are re-exported from plugin
 * barrels that get imported by Node's tsx ESM loader. A direct `.css` import
 * trips `ERR_UNKNOWN_FILE_EXTENSION`, so we ship the stylesheet as a string
 * constant alongside the source `.css`. Generating that string from the `.css`
 * keeps the two from drifting.
 *
 * To opt a new component in: add its `.css` path to `TARGETS` below. The
 * generated `.css.ts` is gitignored (see root `.gitignore`) and rebuilt on
 * every `bun run build` (or `bun run generate:css-strings`).
 *
 * Single source of truth: the `.css` file. The `.css.ts` is fully generated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

// Explicit allowlist. Add a path here to opt a component in.
const TARGETS = [];

function constNameFor(cssPath) {
  const base = path.basename(cssPath, ".css");
  return `${base.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_CSS`;
}

function buildTsContent(cssPath, css) {
  const baseName = path.basename(cssPath);
  const constName = constNameFor(cssPath);
  return [
    "// DO NOT EDIT. Auto-generated from",
    `// ${baseName} by packages/scripts/generate-css-strings.mjs.`,
    "// Run `bun run generate:css-strings` (or `bun run build`) to refresh.",
    "",
    `export const ${constName} = ${JSON.stringify(css)};`,
    "",
  ].join("\n");
}

let updated = 0;
for (const rel of TARGETS) {
  const cssPath = path.join(repoRoot, rel);
  const tsPath = `${cssPath}.ts`;
  const css = readFileSync(cssPath, "utf8");
  const next = buildTsContent(cssPath, css);
  let current = "";
  try {
    current = readFileSync(tsPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (current === next) continue;
  writeFileSync(tsPath, next);
  updated++;
  console.log(
    `[generate-css-strings] wrote ${path.relative(repoRoot, tsPath)}`,
  );
}
console.log(
  `[generate-css-strings] processed ${TARGETS.length} target(s), updated ${updated}`,
);
