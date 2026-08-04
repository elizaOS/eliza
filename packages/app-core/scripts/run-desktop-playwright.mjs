#!/usr/bin/env node
/**
 * Windows-only wrapper for packaged desktop Playwright validation: exits 0 on
 * other platforms (the lane runs in release CI) and runs
 * test:desktop:playwright:windows with Bun on Windows.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const candidateRoots = [
  path.resolve(import.meta.dirname, "..", "..", "..", ".."),
  path.resolve(import.meta.dirname, ".."),
];
const repoRoot =
  candidateRoots.find((candidate) =>
    fs.existsSync(path.join(candidate, "apps", "app", "package.json")),
  ) ?? path.resolve(import.meta.dirname, "..");
const bunCommand =
  process.env.BUN?.trim() || (process.platform === "win32" ? "bun.exe" : "bun");

if (process.platform !== "win32") {
  console.log(
    "[desktop-playwright] Skipping packaged Playwright validation on non-Windows; the Windows-only lane runs in release CI.",
  );
  process.exit(0);
}

const result = spawnSync(
  bunCommand,
  ["run", "test:desktop:playwright:windows"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
