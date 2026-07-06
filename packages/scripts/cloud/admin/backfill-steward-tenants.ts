#!/usr/bin/env bun
// Drives the cloud admin one-off backfill of per-org Steward tenants (#14645).
//
// Provisions a Steward tenant for every org that still has a NULL
// steward_tenant_id (orgs that signed up before PR #14869 made tenants eager
// at signup). Without this, `GET /steward/user/me/tenants` 403s those existing
// users into an infinite /login loop. `ensureStewardTenant` is idempotent +
// 409-tolerant, so this is safe to (re)run and no-ops for orgs already linked.

import type { StewardTenantBackfillOptions } from "@/lib/services/steward-tenant-migration";
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
Backfill Steward Tenants (#14645)
=================================

Provisions a Steward tenant for every org with a NULL steward_tenant_id
(pre-#14869 signups) so GET /steward/user/me/tenants stops returning 403 and
bouncing those users to /login forever. Idempotent + 409-tolerant: safe to
re-run; no-ops for orgs that already have a tenant.

Usage:
  bun run packages/scripts/cloud/admin/backfill-steward-tenants.ts [options]

Options:
  --batch-size <n>  Orgs to provision per concurrent batch (default: 25)
  --max-orgs <n>    Stop after processing at most n candidate orgs
  --dry-run         List candidate orgs without provisioning
  --help            Show this message
`);
    process.exit(0);
  }

  const { backfillStewardTenants } = await import(
    "@/lib/services/steward-tenant-migration"
  );

  const options: StewardTenantBackfillOptions = {
    batchSize: parseNumberFlag(args, "--batch-size"),
    maxOrgs: parseNumberFlag(args, "--max-orgs"),
    dryRun: args.includes("--dry-run"),
  };

  console.log("Starting Steward tenant backfill...");
  if (options.dryRun) {
    console.log("Running in dry-run mode.");
  }

  const summary = await backfillStewardTenants(options);

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
  console.error(
    "Backfill failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
