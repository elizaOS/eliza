#!/usr/bin/env bun
/**
 * Orchestrator for vendor docs generation.
 *
 * Convention:
 *   - Each vendor has a script named: scripts/docs/pull_<vendor>_docs.ts
 *   - This script will:
 *       - Discover all such files.
 *       - Derive <vendor> from the filename.
 *       - Run each script in parallel as:
 *           bun scripts/docs/pull_<vendor>_docs.ts --output docs/vendors/<vendor>
 *
 * Usage:
 *   bun run docs:generate
 */

import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const scriptsDir = dirname(new URL(import.meta.url).pathname);
const rootDir = resolve(scriptsDir, "../..");
const vendorsRoot = join(rootDir, "docs/vendors");

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function main() {
  await ensureDir(vendorsRoot);

  const entries = await readdir(scriptsDir);
  const pullScripts = entries.filter(
    (name) => name.startsWith("pull_") && name.endsWith("_docs.ts"),
  );

  if (pullScripts.length === 0) {
    console.log("No pull_*_docs.ts scripts found in scripts/docs/");
    return;
  }

  console.log("Found vendor doc scripts:", pullScripts.join(", "));

  const processes: Array<ReturnType<typeof Bun.spawn>> = [];

  for (const scriptName of pullScripts) {
    const vendor = scriptName.slice("pull_".length, -"_docs.ts".length);
    const scriptPath = join(scriptsDir, scriptName);
    const outputDir = join(vendorsRoot, vendor);

    console.log(
      `→ Running ${scriptName} for vendor "${vendor}" → ${outputDir}`,
    );

    const proc = Bun.spawn(["bun", scriptPath, "--output", outputDir], {
      cwd: rootDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    processes.push(proc);
  }

  const exits = await Promise.all(processes.map((p) => p.exited));
  const failures = exits.filter((code) => code !== 0);

  if (failures.length > 0) {
    console.error(
      `Some vendor docs scripts failed (codes: ${failures.join(", ")}).`,
    );
    process.exit(1);
  }

  console.log("All vendor docs pulled successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
