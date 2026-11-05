/**
 * A Worker request resolved on the authoritative path must carry the same
 * authorization facts whether or not the positive authorization cache is
 * staged on. Paid proxy and speech dispatch refuse to serve without the
 * admission snapshot, and an app-scoped key must keep its scope, so
 * `INFERENCE_AUTH_CACHE_ENABLED=false` may only remove cache reads and writes.
 *
 * The harness is real PGlite: the shared billing snapshot fixture builds the
 * production subscription, entitlement and quota tables the policy reader
 * needs, and no database adapter or auth collaborator is replaced.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
// An enabled in-memory cache backend is the deployed shape; the resolver must
// still prove its origin path here rather than falling back to "no backend".
process.env.CACHE_ENABLED = "true";
process.env.MOCK_REDIS = "1";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";
import { userModerationStatus } from "../../db/schemas/moderation-violations";
import { users } from "../../db/schemas/users";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  __clearInferenceApiKeyHydrations,
  type InferenceAuthResolution,
  resolveInferenceAuthContext,
} from "./inference-auth-context";

const ORG = "61000000-0000-4000-8000-000000025101";
const USER = "62000000-0000-4000-8000-0000000000a1";
const APP = "63000000-0000-4000-8000-0000000000a1";

async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

let rawKey = "";

beforeAll(async () => {
  const client = getPgliteClientForTests();
  await createBillingSnapshotFixture((query) => client.exec(query), "");
  // The fixture keeps a bare `users(id)` shell for the billing migrations; the
  // auth chain reads the real user row, so replace it with the schema columns.
  await client.exec(`DROP TABLE users CASCADE`);
  await createTable(users);
  await createTable(userModerationStatus);
  // A fresh organization starts on the legacy pay-as-you-go policy branch
  // (the fixture's own organization stays a subscriber), which is the shape a
  // cache-disabled Worker request resolves on.
  await client.query(
    `INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
       settings, is_active, auto_top_up_enabled, account_lifecycle_state)
     VALUES ($1, '12.500000', 1, 0, '{}', true, false, 'active')`,
    [ORG],
  );

  await client.query(`INSERT INTO users(id, organization_id, is_active) VALUES ($1, $2, true)`, [
    USER,
    ORG,
  ]);
  rawKey = `eliza_worker_context_${Date.now()}`;
  await client.query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, is_active,
       usage_count, rate_limit, created_at, updated_at)
     VALUES (gen_random_uuid(), 'worker-context', $1, 'eliza_wo', $2, $3, true, 0, 1000, now(), now())`,
    [createHash("sha256").update(rawKey).digest("hex"), ORG, USER],
  );
  await client.query(`INSERT INTO apps(id, api_key_id) VALUES ($1, (SELECT id FROM api_keys))`, [
    APP,
  ]);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

const cacheDisabledBindings = {
  INFERENCE_AUTH_CACHE_ENABLED: "false",
  INFERENCE_STRONG_REVOCATION_ENABLED: "false",
};

async function resolveAsWorker(
  bindings: Record<string, unknown>,
): Promise<InferenceAuthResolution> {
  __clearInferenceApiKeyHydrations();
  return await runWithCloudBindingsAsync(bindings, () =>
    resolveInferenceAuthContext(
      new Request("https://api.eliza.app/api/v1/apis/birdeye/v1/defi/price", {
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      { cacheOnly: true, executionCtx: { waitUntil() {} } },
    ),
  );
}

describe("cache-disabled Worker origin resolution", () => {
  test("carries the admission snapshot and app-key scope paid dispatch requires", async () => {
    const resolution = await resolveAsWorker(cacheDisabledBindings);
    expect(resolution.kind).toBe("authorized");
    if (resolution.kind !== "authorized") return;
    expect(resolution.source).toBe("origin");
    expect(resolution.ctx.admission).toMatchObject({
      rateLimits: { standardRpm: expect.any(Number) },
      balance: { balanceUsd: expect.any(Number) },
    });
    expect(resolution.ctx.appScopeId).toBe(APP);
  });
});
