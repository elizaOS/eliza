#!/usr/bin/env node
/**
 * patch-nested-core-dist.mjs
 *
 * Bun caches older @elizaos/core versions (e.g. alpha.70) as nested
 * dependencies inside plugin packages. Some of those cached snapshots were
 * published without the full dist/ tree (only dist/testing/ is present),
 * so the package.json `bun`/`node`/`default` export pointing to
 * dist/node/index.node.js fails to resolve at runtime.
 *
 * This script finds every bun-cached @elizaos/core that is missing
 * dist/node/index.node.js and replaces the entire dist/ with the local
 * packages/core/dist/ so all subpath exports resolve correctly.
 */

import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");
// @elizaos/core source lives under packages/core (current) or packages/typescript
// (legacy). Prefer the current name and fall back so older branches still work.
const localCoreDist = existsSync(join(repoRoot, "packages", "core", "dist"))
  ? join(repoRoot, "packages", "core", "dist")
  : join(repoRoot, "packages", "typescript", "dist");

if (!existsSync(bunCacheDir)) {
  process.exit(0);
}

if (!existsSync(join(localCoreDist, "node", "index.node.js"))) {
  console.warn(
    "[patch-nested-core-dist] Local @elizaos/core dist/node/ not built yet — skipping patch.",
  );
  process.exit(0);
}

let patched = 0;

for (const entry of readdirSync(bunCacheDir)) {
  if (!entry.startsWith("@elizaos+")) continue;

  const nestedCore = join(
    bunCacheDir,
    entry,
    "node_modules",
    "@elizaos",
    "core",
  );
  if (!existsSync(nestedCore)) continue;

  const nestedDist = join(nestedCore, "dist");
  // Check for top-level index.js as the completeness sentinel — the broken npm
  // publishes only ship dist/testing/ (and old partial patches only added dist/node/)
  if (existsSync(join(nestedDist, "index.js"))) continue; // already complete

  if (
    !existsSync(localCoreDist) ||
    !existsSync(join(localCoreDist, "node", "index.node.js"))
  ) {
    console.warn(
      "[patch-nested-core-dist] Local @elizaos/core dist missing — skipping nested repair.",
    );
    continue;
  }

  console.log(`[patch-nested-core-dist] Replacing dist/ in ${nestedCore}`);
  // Remove the incomplete dist and replace with the full local build
  if (existsSync(nestedDist)) {
    rmSync(nestedDist, { recursive: true, force: true });
  }
  cpSync(localCoreDist, nestedDist, { recursive: true });
  patched++;
}

if (patched > 0) {
  console.log(
    `[patch-nested-core-dist] Repaired ${patched} nested @elizaos/core dist(s).`,
  );
}
