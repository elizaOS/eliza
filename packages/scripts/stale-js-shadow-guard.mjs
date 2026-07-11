#!/usr/bin/env node
/**
 * Prevent ignored JavaScript artifacts from shadowing colocated TypeScript sources during builds.
 */

import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function findStaleJsShadows(root = scriptRoot) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/src/**/*.js",
      ":(exclude,glob)**/node_modules/**",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => {
      const stem = resolve(root, path.slice(0, -3));
      return existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`);
    })
    .sort();
}

export function run({ root = scriptRoot, clean = false } = {}) {
  if (!existsSync(resolve(root, ".git"))) {
    process.stdout.write(
      "Skipping ignored JavaScript shadow check because Git metadata is unavailable.\n",
    );
    return 0;
  }

  const shadows = findStaleJsShadows(root);
  if (shadows.length === 0) {
    process.stdout.write("No ignored JavaScript source shadows found.\n");
    return 0;
  }

  if (clean) {
    for (const path of shadows) unlinkSync(resolve(root, path));
    process.stdout.write(`Removed ${shadows.length} ignored JavaScript source shadow(s):\n`);
    for (const path of shadows) process.stdout.write(`  ${path}\n`);
    return 0;
  }

  process.stderr.write(
    "Ignored JavaScript files are shadowing TypeScript sources and may poison builds:\n",
  );
  for (const path of shadows) process.stderr.write(`  ${path}\n`);
  process.stderr.write("Run `bun run clean:stale-js` to remove them.\n");
  return 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const clean = process.argv.includes("--clean");
  process.exitCode = run({ clean });
}
