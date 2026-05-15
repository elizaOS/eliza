#!/usr/bin/env bun

import type { StewardUserBackfillOptions } from "@/lib/services/steward-user-migration";
import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles();

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const rawValue = args[index + 1];
  if (!rawValue) {
    throw new Error(`Missing value for ${flag}`);
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid value for ${flag}: ${rawValue}`);
  }

  return value;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Backfill Steward User Mappings
==============================

Usage:
  bun run packages/scripts/backfill-steward-users.ts [options]

Options:
  --batch-size <n>  Number of users to process per batch (default: 50)
  --max-users <n>   Stop after processing at most n users
  --dry-run         Print candidates without creating Steward users
  --help            Show this message
`);
    process.exit(0);
  }

  const { backfillStewardUserMappings } = await import("@/lib/services/steward-user-migration");

  const options: StewardUserBackfillOptions = {
    batchSize: parseNumberFlag(args, "--batch-size"),
    maxUsers: parseNumberFlag(args, "--max-users"),
    dryRun: args.includes("--dry-run"),
  };

  console.log("Starting Steward user backfill...");
  if (options.dryRun) {
    console.log("Running in dry-run mode.");
  }

  const summary = await backfillStewardUserMappings(options);

  console.log("\nBackfill summary");
  console.log("================");
  console.log(`Scanned:     ${summary.scanned}`);
  console.log(`Provisioned: ${summary.provisioned}`);
  console.log(`Failed:      ${summary.failed}`);
  console.log(`Dry run:     ${summary.dryRun ? "yes" : "no"}`);

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Backfill failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
