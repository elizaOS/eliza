#!/usr/bin/env node
/**
 * patch-nested-agent-dist.mjs
 *
 * The published @elizaos/agent@2.0.0-beta.1 (and other 2.0.0-beta.* publishes
 * that picked up the same bug) shipped with a misconfigured outer
 * package.json: `main`, `bin`, and `exports` point at `src/*.ts` source files,
 * but only `src/bin.ts` and `src/index.ts` are actually in the tarball — the
 * rest of `src/actions/...` etc. lives in `dist/packages/agent/src/...`
 * because the build script copied compiled artefacts there and
 * `publishConfig.directory: "dist"` was intended to publish from `dist/`.
 *
 * Bun resolves the cached npm tarball at
 *   node_modules/.bun/@elizaos+agent@2.0.0-beta.{hash}/node_modules/@elizaos/agent
 * for every plugin whose package.json pins `"@elizaos/agent": "2.0.0-beta.1"`
 * (a registry pin rather than `workspace:*`). Loading
 * `@elizaos/agent`'s `src/index.ts` then throws:
 *
 *   Cannot find module './actions/extract-params.ts'
 *
 * because that file is only in the inner `dist/` tree.
 *
 * Mirrors `patch-nested-core-dist.mjs`. The repair: rewrite the OUTER
 * `package.json` to point at the existing inner `dist/packages/agent/src/*`
 * compiled artefacts, leaving the broken `src/` directory alone (nothing
 * references it after the rewrite).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");

if (!existsSync(bunCacheDir)) {
  process.exit(0);
}

let patched = 0;
let skipped = 0;

for (const entry of readdirSync(bunCacheDir)) {
  if (!entry.startsWith("@elizaos+agent@")) continue;

  const pkgRoot = join(bunCacheDir, entry, "node_modules", "@elizaos", "agent");
  if (!existsSync(pkgRoot)) continue;

  const outerPkgPath = join(pkgRoot, "package.json");
  const distPkgPath = join(pkgRoot, "dist", "package.json");
  const distSrcIndex = join(
    pkgRoot,
    "dist",
    "packages",
    "agent",
    "src",
    "index.js",
  );

  if (
    !existsSync(outerPkgPath) ||
    !existsSync(distPkgPath) ||
    !existsSync(distSrcIndex)
  ) {
    skipped++;
    continue;
  }

  const outer = JSON.parse(readFileSync(outerPkgPath, "utf8"));
  // Idempotency: if `main` already points inside dist/, treat as patched.
  if (typeof outer.main === "string" && outer.main.startsWith("./dist/")) {
    continue;
  }

  const dist = JSON.parse(readFileSync(distPkgPath, "utf8"));

  // Rewrite the inner-dist paths (./packages/agent/src/...) to be relative to
  // the package root (./dist/packages/agent/src/...). Apply uniformly to
  // every string value across `main`, `bin`, `types`, and `exports`.
  const reroot = (s) => {
    if (typeof s !== "string") return s;
    if (s.startsWith("./packages/agent/src/")) {
      return `./dist${s.slice(1)}`;
    }
    return s;
  };

  const remapObject = (value) => {
    if (value === null || typeof value !== "object") {
      return reroot(value);
    }
    if (Array.isArray(value)) {
      return value.map(remapObject);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = remapObject(v);
    }
    return out;
  };

  const patchedFields = {
    main: reroot(dist.main),
    types: reroot(dist.types),
    bin: remapObject(dist.bin),
    exports: remapObject(dist.exports),
  };

  // Preserve the rest of the outer package.json (deps, peerDeps, etc.) and
  // overwrite only the broken resolution fields. Drop `files` so consumers
  // don't get a publish-time view that hides dist/.
  const repaired = {
    ...outer,
    ...patchedFields,
  };
  delete repaired.files;

  writeFileSync(outerPkgPath, `${JSON.stringify(repaired, null, 2)}\n`);
  console.log(`[patch-nested-agent-dist] Repaired ${pkgRoot}`);
  patched++;
}

if (patched > 0) {
  console.log(
    `[patch-nested-agent-dist] Repaired ${patched} nested @elizaos/agent package.json(s)${skipped ? ` (${skipped} skipped, missing dist)` : ""}.`,
  );
}
