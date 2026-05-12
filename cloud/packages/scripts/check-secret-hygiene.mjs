#!/usr/bin/env node
/**
 * Ensures dotenv files that must stay untracked are not committed.
 * Run from repo root: node packages/scripts/check-secret-hygiene.mjs
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main() {
  if (!existsSync(join(repoRoot, ".git"))) {
    console.log("[check-secret-hygiene] No .git; skipping.");
    process.exit(0);
  }

  let tracked;
  try {
    tracked = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error("[check-secret-hygiene] git ls-files failed");
    process.exit(1);
  }

  const bad = [];
  const forbiddenBasenames = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.dev",
    ".env.development",
  ]);

  for (const line of tracked.split("\n")) {
    const rel = line.trim();
    if (!rel) continue;
    if (forbiddenBasenames.has(basename(rel))) {
      bad.push(rel);
    }
  }

  if (bad.length > 0) {
    console.error("[check-secret-hygiene] Tracked env files that must not be in git:");
    for (const p of bad) console.error(`  ${p}`);
    process.exit(1);
  }

  console.log("[check-secret-hygiene] OK.");
}

main();
