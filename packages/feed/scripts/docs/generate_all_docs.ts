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
 * Also runs skills generator (docs/skills.md + skills/feed/) after vendor pulls.
 * WHY: One command should refresh all docs that agents and LLMs might read (vendor + our A2A/MCP surface);
 * otherwise we forget to run skills:generate when we change endpoints.
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

  if (pullScripts.length > 0) {
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
  } else {
    console.log("No pull_*_docs.ts scripts found in scripts/docs/");
  }

  // Run skills generator so A2A/MCP docs stay in sync with code (see script WHY in generate-skills-md.ts).
  // Markdown and package write to different files, so run in parallel.
  console.log("");
  console.log(
    "→ Running skills generator (docs/skills.md + skills/feed/) in parallel...",
  );
  const skillsScript = join(rootDir, "scripts/generate-skills-md.ts");
  const skillsMd = Bun.spawn(["bun", "run", skillsScript], {
    cwd: rootDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const skillsPkg = Bun.spawn(["bun", "run", skillsScript, "--package"], {
    cwd: rootDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const [codeMd, codePkg] = await Promise.all([
    skillsMd.exited,
    skillsPkg.exited,
  ]);
  if (codeMd !== 0) {
    console.error("Skills generator (markdown) failed.");
    process.exit(1);
  }
  if (codePkg !== 0) {
    console.error("Skills generator (package) failed.");
    process.exit(1);
  }
  console.log("Skills generated successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
