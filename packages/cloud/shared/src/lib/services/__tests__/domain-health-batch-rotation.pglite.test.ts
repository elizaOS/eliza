/**
 * The domain-health cron probes a fixed batch of candidates each tick. A domain
 * that stays unreachable keeps `is_live = false`, so it stays a candidate. When
 * the candidate set is larger than the batch, the query must return the domains
 * that waited longest (never checked first), or the same rows are probed on
 * every tick and every later domain is never checked while the cron reports a
 * healthy run.
 *
 * Real schema, real query, isolated in-process PGlite. No service mocks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

/** Rows the cron may probe in one tick (DOMAIN_HEALTH_BATCH, shrunk for the test). */
const BATCH = 5;
const CHECKED_ROWS = 30;
const NEVER_CHECKED_ROWS = 2;
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000009001";

let closeDatabaseConnectionsForTests: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let dbWrite: typeof import("../../../db/client").dbWrite;
let listCloudflareNeedingHealthCheck: typeof import("../managed-domains").listCloudflareNeedingHealthCheck;

function idFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client"));
  ({ listCloudflareNeedingHealthCheck } = await import("../managed-domains"));

  await dbWrite.execute(
    sql.raw(`
      CREATE TABLE managed_domains (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        domain text NOT NULL,
        registrar text NOT NULL DEFAULT 'external',
        registered_at timestamp,
        expires_at timestamp,
        auto_renew boolean NOT NULL DEFAULT true,
        status text NOT NULL DEFAULT 'pending',
        registrant_info jsonb,
        resource_type text,
        app_id uuid,
        container_id uuid,
        agent_id uuid,
        mcp_id uuid,
        nameserver_mode text NOT NULL DEFAULT 'external',
        dns_records jsonb DEFAULT '[]'::jsonb,
        ssl_status text DEFAULT 'pending',
        ssl_expires_at timestamp,
        verified boolean NOT NULL DEFAULT false,
        verification_token text,
        verified_at timestamp,
        moderation_status text NOT NULL DEFAULT 'clean',
        moderation_flags jsonb DEFAULT '[]'::jsonb,
        last_health_check timestamp,
        is_live boolean NOT NULL DEFAULT false,
        health_check_error text,
        content_hash text,
        last_content_scan_at timestamp,
        last_ai_scan_at timestamp,
        ai_scan_model text,
        content_scan_confidence real,
        content_scan_cache jsonb,
        suspended_at timestamp,
        suspension_reason text,
        suspension_notification jsonb,
        owner_notified_at timestamp,
        cloudflare_zone_id text,
        cloudflare_registration_id text,
        purchase_price text,
        renewal_price text,
        payment_method text,
        stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `),
  );

  // Insertion order is the opposite of check age: the most recently checked row
  // is written first, so a query with no ordering returns the wrong end of the
  // queue. Row i was last checked i + 1 hours ago.
  const checkedValues = Array.from({ length: CHECKED_ROWS }, (_, index) => {
    const hoursAgo = index + 1;
    return `('${idFor(index)}', '${ORGANIZATION_ID}', 'checked-${index}.example', 'cloudflare', 'active', true, false, now() - interval '${hoursAgo} hours')`;
  }).join(",\n");
  await dbWrite.execute(
    sql.raw(`
      INSERT INTO managed_domains
        (id, organization_id, domain, registrar, status, verified, is_live, last_health_check)
      VALUES ${checkedValues}
    `),
  );

  const neverCheckedValues = Array.from({ length: NEVER_CHECKED_ROWS }, (_, index) => {
    const row = CHECKED_ROWS + index;
    return `('${idFor(row)}', '${ORGANIZATION_ID}', 'never-${row}.example', 'cloudflare', 'active', true, false, NULL)`;
  }).join(",\n");
  await dbWrite.execute(
    sql.raw(`
      INSERT INTO managed_domains
        (id, organization_id, domain, registrar, status, verified, is_live, last_health_check)
      VALUES ${neverCheckedValues}
    `),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("domain health check batch selection", () => {
  test("probes never-checked and longest-waiting domains first", async () => {
    const batch = await listCloudflareNeedingHealthCheck(BATCH);

    expect(batch.length).toBe(BATCH);
    expect(batch.map((row) => row.domain)).toEqual([
      // Never probed: no check stamp yet.
      `never-${CHECKED_ROWS}.example`,
      `never-${CHECKED_ROWS + 1}.example`,
      // Then the oldest check stamps.
      `checked-${CHECKED_ROWS - 1}.example`,
      `checked-${CHECKED_ROWS - 2}.example`,
      `checked-${CHECKED_ROWS - 3}.example`,
    ]);
  });
});
