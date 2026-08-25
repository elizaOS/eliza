/**
 * Prevents prose-header coverage from regressing while the remaining test
 * backlog is repaired in reviewable comment-only batches.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "src");
const baselinePath = path.join(
  import.meta.dirname,
  "file-header-baseline.json",
);
const ignoredSegments = new Set([
  "__e2e__",
  "__screenshots__",
  "generated",
  "output",
  "output-perf-gate",
]);

async function collect(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file, result);
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) result.push(file);
  }
  return result;
}

function isGenerated(file, source) {
  return (
    /(?:\.generated\.|\/fixtures\/known-phrase\.ts$)/.test(file) ||
    /AUTO-GENERATED|@generated/.test(source.slice(0, 300))
  );
}

function hasHeader(source) {
  const normalized = source
    .replace(/^#![^\n]*\n/, "")
    .replace(/^(?:"use (?:client|server)"|'use (?:client|server)');\s*/, "")
    .trimStart();
  return normalized.startsWith("/**");
}

const missing = { production: [], tests: [] };
for (const file of await collect(sourceRoot)) {
  const source = await readFile(file, "utf8");
  if (isGenerated(file, source) || hasHeader(source)) continue;
  const relative = path.relative(root, file);
  const bucket = /(?:\.test\.|\.stories\.|\/__tests__\/)/.test(relative)
    ? "tests"
    : "production";
  missing[bucket].push(relative);
}

if (process.argv.includes("--update-baseline")) {
  await writeFile(
    baselinePath,
    `${JSON.stringify(
      {
        production: missing.production.length,
        tests: missing.tests.length,
      },
      null,
      2,
    )}\n`,
  );
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const regressions = Object.entries(missing).filter(
  ([bucket, files]) => files.length > baseline[bucket],
);
if (regressions.length > 0) {
  for (const [bucket, files] of regressions) {
    console.error(
      `${bucket} header gaps increased: ${files.length} > ${baseline[bucket]}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `file-header ratchet passed (production=${missing.production.length}, tests=${missing.tests.length})`,
  );
}
