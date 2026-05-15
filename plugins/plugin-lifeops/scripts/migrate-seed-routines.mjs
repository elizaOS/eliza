#!/usr/bin/env node
/**
 * Wave-2 W2-A driver for the seed-routine migrator.
 *
 *   node plugins/app-lifeops/scripts/migrate-seed-routines.mjs --agent <id>
 *     [--apply] [--out <path>]
 *
 * Defaults to dry-run; emits a JSON manual-review report to stdout (or
 * `--out <path>` when supplied). Pass `--apply` to schedule the
 * matched `ScheduledTaskSeed` records via the live runner and stamp
 * `metadata.migratedToScheduledTaskId` on each legacy definition row.
 *
 * The script intentionally does not bootstrap a full Eliza runtime —
 * it expects the caller to either:
 *
 *   1. point it at a JSON snapshot of the legacy definitions
 *      (`--snapshot <path>`), in which case dry-run runs purely
 *      offline; or
 *   2. import the migrator from `@elizaos/app-lifeops` inside a host
 *      process that already holds a `LifeOpsRepository` + a
 *      `ScheduledTaskRunner` and call `applySeedRoutineMigration({...})`
 *      directly.
 *
 * The 1) snapshot path covers staging-data dry-runs (per IMPL §5.1
 * verification: "Migrator dry-run on staging data produces a sane
 * diff"); the 2) live path is the ops-room rollout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = {
    agentId: null,
    apply: false,
    snapshot: null,
    outPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      out.apply = true;
    } else if (arg === "--agent") {
      out.agentId = argv[++i];
    } else if (arg === "--snapshot") {
      out.snapshot = argv[++i];
    } else if (arg === "--out") {
      out.outPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsageAndExit(2);
    }
  }
  return out;
}

function printUsageAndExit(code) {
  console.error(
    `Usage: migrate-seed-routines.mjs --agent <id> [--apply] [--snapshot <path>] [--out <path>]`,
  );
  process.exit(code);
}

async function loadModule() {
  // The script is shipped alongside the plugin; resolve the migrator
  // through the package entry point so test/dev/prod paths converge.
  return import("@elizaos/app-lifeops/seed-routine-migrator");
}

async function runFromSnapshot(args, mod) {
  if (!args.snapshot) {
    return null;
  }
  const snapshotPath = resolve(process.cwd(), args.snapshot);
  const definitions = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Array.isArray(definitions)) {
    throw new Error(
      `Snapshot at ${snapshotPath} must be a JSON array of LifeOpsTaskDefinition rows`,
    );
  }
  const reader = {
    async listDefinitions() {
      return definitions;
    },
    async updateDefinitionMetadata() {
      throw new Error(
        "Snapshot mode is read-only; refusing to mutate snapshot",
      );
    },
  };
  return mod.buildSeedRoutineMigrationDiff({
    agentId: args.agentId,
    reader,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agentId) {
    console.error("--agent <id> is required");
    printUsageAndExit(2);
  }
  if (args.apply && args.snapshot) {
    console.error(
      "--apply is not supported with --snapshot (snapshot mode is read-only)",
    );
    process.exit(2);
  }

  const mod = await loadModule();

  if (args.snapshot) {
    const diff = await runFromSnapshot(args, mod);
    const json = JSON.stringify(diff, null, 2);
    if (args.outPath) {
      writeFileSync(resolve(process.cwd(), args.outPath), `${json}\n`);
    } else {
      process.stdout.write(`${json}\n`);
    }
    return;
  }

  if (!args.apply) {
    console.error(
      "Live dry-run requires a host process holding a LifeOpsRepository + ScheduledTaskRunner. " +
        "Use --snapshot <path> for offline dry-runs against staging data, or invoke " +
        "`applySeedRoutineMigration({...})` from a script that already has runtime handles.",
    );
    process.exit(2);
  }

  console.error(
    "--apply mode requires invoking `applySeedRoutineMigration({...})` from a host " +
      "process that holds the runtime handles. This script intentionally does not " +
      "bootstrap a full Eliza runtime; see the migrator module docstring.",
  );
  process.exit(2);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
