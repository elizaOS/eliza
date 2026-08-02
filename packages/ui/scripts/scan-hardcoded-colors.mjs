#!/usr/bin/env node
/**
 * Ratchets hardcoded color literals in production UI source. Theme/token files,
 * generated code, tests, stories, and visual-test fixtures are explicit policy
 * boundaries; component code must not add literals beyond the committed count.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const baselinePath = join(
  packageRoot,
  "scripts",
  "hardcoded-color-baseline.json",
);
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

function isPolicyExcluded(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.includes("/styles/") ||
    normalized.includes("/themes/") ||
    normalized.includes("/__e2e__/") ||
    normalized.includes("/__screenshots__/") ||
    normalized.includes("/testing/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.tsx") ||
    normalized.endsWith(".stories.ts") ||
    normalized.endsWith(".stories.tsx") ||
    normalized.includes(".generated.")
  );
}

function sourceFiles(directory, output = []) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    if (statSync(file).isDirectory()) sourceFiles(file, output);
    else if (/\.tsx?$/.test(name) && !isPolicyExcluded(file)) output.push(file);
  }
  return output;
}

function inventory() {
  const counts = {};
  for (const file of sourceFiles(sourceRoot)) {
    const count = readFileSync(file, "utf8").match(COLOR_LITERAL)?.length ?? 0;
    if (count > 0)
      counts[relative(packageRoot, file).replaceAll("\\", "/")] = count;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

const current = inventory();
if (process.argv.includes("--update-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `updated ${relative(packageRoot, baselinePath)} (${Object.keys(current).length} files)`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  throw new Error(
    "Hardcoded-color baseline is missing; run audit:colors:update-baseline intentionally.",
  );
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const regressions = Object.entries(current).filter(
  ([file, count]) => count > (baseline[file] ?? 0),
);
if (regressions.length > 0) {
  for (const [file, count] of regressions) {
    console.error(
      `${file}: ${count} literals (baseline ${baseline[file] ?? 0})`,
    );
  }
  process.exit(1);
}
console.log(
  `hardcoded-color ratchet passed (${Object.keys(current).length} files)`,
);
