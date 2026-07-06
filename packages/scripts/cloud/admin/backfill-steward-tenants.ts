#!/usr/bin/env bun
/**
 * Backfill per-org Steward tenants for organizations created before eager
 * provisioning landed (#14869 / #14645).
 *
 * Orgs born before that fix have `organizations.steward_tenant_id = NULL`
 * (tenants were only created lazily at first agent-provision), which leaves
 * their users unable to complete the console golden path. This walks every
 * NULL-tenant org through the exact production path — `ensureStewardTenant`
 * (idempotent, 409-tolerant, fail-closed on keyless provisions) — so the
 * backfill can be safely re-run and never half-provisions an org.
 *
 * ⚠️ Each provision creates a REAL tenant on the shared Steward service, so
 * the default is a dry-run listing; pass --execute to mutate. Use --org to
 * target specific orgs first (e.g. launch-QA accounts), --limit to bound a
 * run, and --delay-ms to pace the Steward API.
 *
 * Usage:
 *   bun run packages/scripts/cloud/admin/backfill-steward-tenants.ts            # dry-run
 *   bun run ... --org <uuid> [--org <uuid> ...] --execute                       # targeted
 *   bun run ... --limit 100 --execute                                           # bounded batch
 */

import { isNull } from "drizzle-orm";
import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles();

interface Flags {
  execute: boolean;
  orgIds: string[];
  limit: number | undefined;
  delayMs: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    execute: args.includes("--execute"),
    orgIds: [],
    limit: undefined,
    delayMs: 150,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --org");
      flags.orgIds.push(value);
      i++;
    } else if (args[i] === "--limit" || args[i] === "--delay-ms") {
      const value = Number.parseInt(args[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid value for ${args[i]}: ${args[i + 1]}`);
      }
      if (args[i] === "--limit") flags.limit = value;
      else flags.delayMs = value;
      i++;
    }
  }
  return flags;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Backfill per-org Steward tenants (#14645)
=========================================

Options:
  --execute        Actually provision (default: dry-run listing only)
  --org <uuid>     Target specific org id(s); repeatable. Skips the NULL scan.
  --limit <n>      Process at most n orgs
  --delay-ms <n>   Pause between provisions (default: 150)
  --help           Show this message
`);
    process.exit(0);
  }

  const flags = parseFlags(args);

  const { db } = await import("@elizaos/cloud-shared/db/client");
  const { organizations } = await import("@elizaos/cloud-shared/db/schemas/organizations");
  const { ensureStewardTenant } = await import(
    "@elizaos/cloud-shared/lib/services/steward-tenant-config"
  );
  const { isStewardPlatformConfigured } = await import(
    "@elizaos/cloud-shared/lib/services/steward-platform-users"
  );

  if (flags.execute && !isStewardPlatformConfigured()) {
    // Without a platform key ensureStewardTenant silently falls back to the
    // shared default tenant instead of provisioning — that "success" would
    // mark nothing and fix nothing. Refuse to pretend.
    console.error(
      "STEWARD_PLATFORM_KEYS is not configured; --execute would no-op into the default-tenant fallback. Aborting.",
    );
    process.exit(1);
  }

  let candidates: Array<{ id: string; slug: string }>;
  if (flags.orgIds.length > 0) {
    candidates = flags.orgIds.map((id) => ({ id, slug: "(targeted)" }));
  } else {
    const rows = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(isNull(organizations.steward_tenant_id));
    candidates = flags.limit ? rows.slice(0, flags.limit) : rows;
    console.log(
      `Found ${rows.length} org(s) with NULL steward_tenant_id${flags.limit ? `; processing ${candidates.length}` : ""}`,
    );
  }

  if (!flags.execute) {
    for (const org of candidates) console.log(`DRY-RUN would provision: ${org.id} (${org.slug})`);
    console.log(`\nDry-run complete: ${candidates.length} org(s). Re-run with --execute to provision.`);
    process.exit(0);
  }

  let provisioned = 0;
  let alreadyHad = 0;
  let failed = 0;
  for (const [index, org] of candidates.entries()) {
    try {
      const result = await ensureStewardTenant(org.id);
      if (result.isNew) {
        provisioned++;
        console.log(`[${index + 1}/${candidates.length}] provisioned ${result.tenantId} for ${org.id}`);
      } else {
        alreadyHad++;
        console.log(`[${index + 1}/${candidates.length}] already linked ${result.tenantId} for ${org.id}`);
      }
    } catch (error) {
      failed++;
      console.error(
        `[${index + 1}/${candidates.length}] FAILED ${org.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (flags.delayMs > 0 && index < candidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, flags.delayMs));
    }
  }

  console.log(
    `\nBackfill complete: ${provisioned} provisioned, ${alreadyHad} already linked, ${failed} failed of ${candidates.length}.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
