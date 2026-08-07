#!/usr/bin/env node
/**
 * Runs Biome over the TypeScript source inventory selected by package scripts.
 * Filesystem discovery stays shell-independent so the same scripts work on
 * Windows while preserving the former `find` contract exactly.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function discoverTypeScriptFiles(root) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(file);
      }
    }
  }

  visit(resolve(root));
  return files.sort();
}

export function runBiomeTypeScript(
  root,
  biomeArgs,
  { spawn = spawnSync } = {},
) {
  const files = discoverTypeScriptFiles(root);
  if (files.length === 0) {
    throw new Error(`No TypeScript source files found under ${resolve(root)}`);
  }

  const result = spawn(
    process.platform === "win32" ? "bun.exe" : "bun",
    ["x", "@biomejs/biome", ...biomeArgs, ...files],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Biome exited with code ${result.status ?? 1}`);
  }
}

if (
  import.meta.main ||
  (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
) {
  const [root, ...biomeArgs] = process.argv.slice(2);
  if (!root || biomeArgs.length === 0) {
    throw new Error(
      "Usage: node packages/scripts/run-biome-typescript.mjs <root> <biome args...>",
    );
  }
  runBiomeTypeScript(root, biomeArgs);
}
