#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const coreDistFiles = [
  path.join(repoRoot, "node_modules", "@elizaos", "core", "dist", "browser", "index.browser.js"),
  path.join(repoRoot, "node_modules", "@elizaos", "core", "dist", "edge", "index.edge.js"),
  path.join(repoRoot, "node_modules", "@elizaos", "core", "dist", "node", "index.node.js"),
];

let patchedFiles = 0;
let patchedCalls = 0;

for (const filePath of coreDistFiles) {
  if (!existsSync(filePath)) {
    continue;
  }

  const source = readFileSync(filePath, "utf8");
  const matches = source.match(/\.loose\(\)/g);
  if (!matches) {
    continue;
  }

  const updated = source.replaceAll(".loose()", ".passthrough()");
  if (updated === source) {
    continue;
  }

  writeFileSync(filePath, updated, "utf8");
  patchedFiles += 1;
  patchedCalls += matches.length;
}

console.log(
  `[postinstall] normalized ${patchedCalls} @elizaos/core loose() call(s) across ${patchedFiles} bundle(s)`,
);

// `packages/lib` imports `hono`; resolution walks to `cloud/node_modules`. Bun often
// nests `hono` only under `apps/api/node_modules`, so TypeScript fails unless hoisted.
const apiHono = path.join(repoRoot, "apps", "api", "node_modules", "hono");
const cloudHono = path.join(repoRoot, "node_modules", "hono");
if (existsSync(apiHono) && !existsSync(cloudHono)) {
  mkdirSync(path.dirname(cloudHono), { recursive: true });
  try {
    symlinkSync(apiHono, cloudHono);
    console.log("[postinstall] linked cloud/node_modules/hono -> apps/api/node_modules/hono");
  } catch (err) {
    console.warn("[postinstall] hono hoist symlink skipped:", err);
  }
}
