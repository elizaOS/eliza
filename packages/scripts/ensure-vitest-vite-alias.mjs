#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

const workspacePath = process.argv[2];

if (!workspacePath) {
  throw new Error(
    "Usage: node packages/scripts/ensure-vitest-vite-alias.mjs <workspace-path>",
  );
}

const repoRoot = process.cwd();
const rootAlias = path.join(
  repoRoot,
  "node_modules",
  "@elizaos",
  "vitest-vite",
);
const workspaceAlias = path.join(
  repoRoot,
  workspacePath,
  "node_modules",
  "@elizaos",
  "vitest-vite",
);

if (existsSync(rootAlias)) {
  console.log(`[vitest-vite-alias] root alias already exists: ${rootAlias}`);
  process.exit(0);
}

try {
  const rootAliasStat = lstatSync(rootAlias);
  if (rootAliasStat.isSymbolicLink()) {
    rmSync(rootAlias, { force: true, recursive: true });
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

if (!existsSync(workspaceAlias)) {
  throw new Error(
    `Filtered install did not create ${workspaceAlias}; cannot expose @elizaos/vitest-vite`,
  );
}

mkdirSync(path.dirname(rootAlias), { recursive: true });

// Vitest resolves its Vite peer from the root virtual-store package. A Bun
// filtered install can keep the alias only under the filtered workspace, so
// expose that same package at the root without widening the CI install.
const aliasTarget = realpathSync(workspaceAlias);
symlinkSync(
  aliasTarget,
  rootAlias,
  process.platform === "win32" ? "junction" : "dir",
);

console.log(`[vitest-vite-alias] linked ${rootAlias} -> ${aliasTarget}`);
