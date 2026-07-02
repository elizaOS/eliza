/**
 * #11024 — an unverified external-domain attach must not be a GLOBAL ownership
 * lock. Real in-process PGlite, real `managedDomainsService` readers, real
 * indexes from migration 0163: only VERIFIED / cloudflare rows are globally
 * exclusive; different orgs may each hold a competing UNVERIFIED pending row.
 *
 * The table is raw-created here (enum columns as TEXT — drizzle reads/writes them
 * as strings) with exactly the migration's two indexes, so the test exercises the
 * real uniqueness semantics without pulling the full FK closure.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports. resolveDatabaseUrl
// prefers TEST_DATABASE_URL, so BOTH are pinned — otherwise the suite is steered
// to a Postgres that isn't up under the unit lane and self-skips to a vacuous
// green (a money-path proof shipping unproven).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { and, eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { managedDomains } from "../../../db/schemas/managed-domains";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let svc: typeof import("../managed-domains").managedDomainsService;

let seq = 0;
const orgId = (): string => {
  seq += 1;
  // deterministic uuid-shaped ids
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

async function insertRow(row: {
  organizationId: string;
  domain: string;
  registrar?: "external" | "cloudflare";
  verified?: boolean;
  createdAt?: Date;
}): Promise<string> {
  const [created] = await dbWrite
    .insert(managedDomains)
    .values({
      organizationId: row.organizationId,
      domain: row.domain,
      registrar: row.registrar ?? "external",
      verified: row.verified ?? false,
      status: "pending",
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    })
    .returning({ id: managedDomains.id });
  return created.id;
}

beforeAll(async () => {
  try {
    ({ managedDomainsService: svc } = await import("../managed-domains"));
    // Raw table + the exact indexes migration 0163 creates. Enum columns are
    // TEXT (drizzle round-trips them as strings). FKs omitted (irrelevant to
    // uniqueness); only the columns the schema maps are present.
    await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS "managed_domains" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" uuid NOT NULL,
        "domain" text NOT NULL,
        "registrar" text NOT NULL DEFAULT 'external',
        "registered_at" timestamp, "expires_at" timestamp,
        "auto_renew" boolean NOT NULL DEFAULT true,
        "status" text NOT NULL DEFAULT 'pending',
        "registrant_info" jsonb,
        "resource_type" text,
        "app_id" uuid, "container_id" uuid, "agent_id" uuid, "mcp_id" uuid,
        "nameserver_mode" text NOT NULL DEFAULT 'external',
        "dns_records" jsonb DEFAULT '[]'::jsonb,
        "ssl_status" text DEFAULT 'pending', "ssl_expires_at" timestamp,
        "verified" boolean NOT NULL DEFAULT false,
        "verification_token" text, "verified_at" timestamp,
        "moderation_status" text NOT NULL DEFAULT 'clean',
        "moderation_flags" jsonb DEFAULT '[]'::jsonb,
        "last_health_check" timestamp,
        "is_live" boolean NOT NULL DEFAULT false,
        "health_check_error" text, "content_hash" text,
        "last_content_scan_at" timestamp, "last_ai_scan_at" timestamp,
        "ai_scan_model" text, "content_scan_confidence" real,
        "content_scan_cache" jsonb, "suspended_at" timestamp,
        "suspension_reason" text, "suspension_notification" jsonb,
        "owner_notified_at" timestamp,
        "cloudflare_zone_id" text, "cloudflare_registration_id" text,
        "purchase_price" text, "renewal_price" text,
        "payment_method" text, "stripe_payment_intent_id" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await dbWrite.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "managed_domains_domain_exclusive_idx" ON "managed_domains" ("domain") WHERE "verified" = true OR "registrar" = 'cloudflare';`,
    );
    await dbWrite.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "managed_domains_org_domain_idx" ON "managed_domains" ("organization_id","domain");`,
    );
  } catch (error) {
    pgliteReady = false;
    console.error("[managed-domains-squat.test] PGlite unavailable — skipping.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  if (pgliteReady) await dbWrite.delete(managedDomains);
});

describe("managed-domains squat fix (#11024)", () => {
  test("pglite applied (loud, never a silent no-op pass)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("two orgs can each hold a competing UNVERIFIED pending row for the same domain (no squat lock)", async () => {
    if (!pgliteReady) return;
    const orgA = orgId();
    const orgB = orgId();

    const aId = await insertRow({ organizationId: orgA, domain: "victim-brand.com" });
    // The rightful org is NOT blocked from inserting its own pending row.
    const bId = await insertRow({ organizationId: orgB, domain: "victim-brand.com" });
    expect(aId).not.toBe(bId);

    // While only unverified rows exist, the domain has NO exclusive owner — the
    // serve/resolve path (which uses getDomainByName) resolves to nothing.
    expect(await svc.getDomainByName("victim-brand.com")).toBeNull();
    // Each org still sees its OWN pending row.
    expect((await svc.getOwnDomainRow(orgA, "victim-brand.com"))?.id).toBe(aId);
    expect((await svc.getOwnDomainRow(orgB, "victim-brand.com"))?.id).toBe(bId);
  });

  test("verifying promotes a row to the exclusive slot; the other org can no longer verify the same domain", async () => {
    if (!pgliteReady) return;
    const orgA = orgId();
    const orgB = orgId();
    await insertRow({ organizationId: orgA, domain: "shared.com" });
    await insertRow({ organizationId: orgB, domain: "shared.com" });

    // Org B proves ownership → its row becomes exclusive.
    await dbWrite
      .update(managedDomains)
      .set({ verified: true })
      .where(and(eq(managedDomains.organizationId, orgB), eq(managedDomains.domain, "shared.com")));

    const exclusive = await svc.getDomainByName("shared.com");
    expect(exclusive?.organizationId).toBe(orgB);

    // Org A can NOT now also verify — the partial unique index forbids a second
    // exclusive row for the domain (this is the race the fix closes at /verify).
    // Wrap in an async IIFE: a drizzle update builder is a thenable query
    // builder, not a real Promise, so `.rejects` must be given an actual Promise.
    await expect(
      (async () => {
        await dbWrite
          .update(managedDomains)
          .set({ verified: true })
          .where(
            and(eq(managedDomains.organizationId, orgA), eq(managedDomains.domain, "shared.com")),
          );
      })(),
    ).rejects.toThrow();
  });

  test("a cloudflare row is exclusive on its own (registrar-based exclusivity)", async () => {
    if (!pgliteReady) return;
    const orgA = orgId();
    await insertRow({
      organizationId: orgA,
      domain: "cf.com",
      registrar: "cloudflare",
      verified: false,
    });
    // Even unverified, a cloudflare row holds the exclusive slot.
    expect((await svc.getDomainByName("cf.com"))?.organizationId).toBe(orgA);
    // A second cloudflare row for the same domain (different org) is refused.
    await expect(
      insertRow({ organizationId: orgId(), domain: "cf.com", registrar: "cloudflare" }),
    ).rejects.toThrow();
  });

  test("an org still can't hold two rows for one domain ((org,domain) unique)", async () => {
    if (!pgliteReady) return;
    const orgA = orgId();
    await insertRow({ organizationId: orgA, domain: "dup.com" });
    await expect(insertRow({ organizationId: orgA, domain: "dup.com" })).rejects.toThrow();
  });

  test("releaseStaleUnverifiedExternals reclaims old unverified externals, spares verified + fresh", async () => {
    if (!pgliteReady) return;
    const old = new Date(Date.now() - 1000 * 60 * 60 * 72); // 72h ago
    const orgStale = orgId();
    const orgFresh = orgId();
    const orgVerified = orgId();

    await insertRow({ organizationId: orgStale, domain: "stale.com", createdAt: old });
    await insertRow({ organizationId: orgFresh, domain: "fresh.com" }); // now
    await insertRow({
      organizationId: orgVerified,
      domain: "verified.com",
      verified: true,
      createdAt: old,
    });

    const released = await svc.releaseStaleUnverifiedExternals(1000 * 60 * 60 * 24); // 24h TTL
    expect(released).toBe(1); // only the stale unverified external

    expect(await svc.getOwnDomainRow(orgStale, "stale.com")).toBeNull(); // reclaimed
    expect(await svc.getOwnDomainRow(orgFresh, "fresh.com")).not.toBeNull(); // spared (fresh)
    expect(await svc.getDomainByName("verified.com")).not.toBeNull(); // spared (verified)
  });
});
