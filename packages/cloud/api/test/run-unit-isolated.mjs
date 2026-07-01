#!/usr/bin/env node
/**
 * Run each cloud-api unit test file in its OWN `bun test` process.
 *
 * WHY: bun evaluates every test file's top-level `mock.module` at collection
 * time in a single shared process, and those overrides are process-global with
 * no per-file teardown. Files that stub overlapping modules with different
 * shapes (e.g. one mocks `@/db/helpers` to `{ dbRead }`, another needs the real
 * surface) cross-contaminate, producing order-dependent flakes. Process-per-file
 * gives each test total isolation — there is no shared module-mock state to
 * leak — which fixes the whole class, current and future, without having to
 * keep 10+ unrelated test files' mocks in manual lockstep.
 *
 * Serial on purpose: avoids any shared-resource contention (ports, temp dirs)
 * between concurrent bun processes. The unit suite is small; correctness first.
 *
 * Usage:
 *   node test/run-unit-isolated.mjs            # every test file under __tests__
 *   node test/run-unit-isolated.mjs <substr>   # only files whose path matches
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const testsDir = path.join(pkgRoot, "__tests__");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const filter = process.argv[2];
let files = walk(testsDir).sort();
if (filter) files = files.filter((f) => f.includes(filter));

if (files.length === 0) {
  console.log("[cloud-api unit] no test files matched");
  process.exit(0);
}

console.log(
  `[cloud-api unit] running ${files.length} file(s) isolated (one bun process each)\n`,
);

const failed = [];
for (const file of files) {
  const rel = path.relative(pkgRoot, file);
  const res = spawnSync("bun", ["test", file], {
    stdio: "inherit",
    cwd: pkgRoot,
    env: process.env,
  });
  if (res.status !== 0) failed.push(rel);
}

console.log("");
if (failed.length > 0) {
  console.error(
    `[cloud-api unit] ${failed.length}/${files.length} file(s) FAILED:`,
  );
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[cloud-api unit] all ${files.length} file(s) passed (isolated)`);
