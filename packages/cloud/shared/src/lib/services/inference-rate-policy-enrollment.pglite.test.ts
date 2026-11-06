/**
 * Rate-only enrollment through the real fence helpers on PGlite, with the
 * organization Durable Object replaced by a recording fake. Enrollment and
 * every later policy write must take a permit before the primary write and
 * publish the advanced epoch after COMMIT; funded escrow is never enabled.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "81000000-0000-4000-8000-000000000001";
const OTHER = "81000000-0000-4000-8000-000000000002";
const KEY = "83000000-0000-4000-8000-000000000001";

let database: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let fence: typeof import("./inference-policy-fence");
let cloudBindings: typeof import("../runtime/cloud-bindings");

let calls: Array<{ name: string; path: string; body: Record<string, unknown> }> = [];

const gate = {
  getByName(name: string) {
    return {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        calls.push({ name, path, body });
        if (path === "/policy-mutation/begin")
          return Response.json({
            blocked: true,
            mutationId: body.mutationId,
            fenceToken: `token-${String(body.mutationId)}`,
            validUntil: Date.now() + 30_000,
          });
        return Response.json({ committed: true });
      },
    };
  },
};

function withFlags<T>(run: () => Promise<T>, ratePolicy = true): Promise<T> {
  return cloudBindings.runWithCloudBindingsAsync(
    {
      INFERENCE_RATE_POLICY_ADMISSION: String(ratePolicy),
      INFERENCE_FUNDED_BUDGET_ADMISSION: "false",
      INFERENCE_ADMISSION_GATES: gate,
    },
    run,
  );
}

async function authority(org: string) {
  const { rows } = await database.getPgliteClientForTests().query<{
    enabled: boolean;
    rate_enabled: boolean;
    epoch: string;
  }>(
    "SELECT enabled, rate_enabled, epoch::text AS epoch FROM inference_policy_authorities WHERE organization_id = $1",
    [org],
  );
  return rows[0];
}

beforeAll(async () => {
  database = await import("../../db/client");
  const client = database.getPgliteClientForTests();
  await client.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY, is_active boolean, account_lifecycle_state text,
      account_deletion_request_id uuid, paid_work_fenced_at timestamptz, settings jsonb);
    CREATE TABLE users(id uuid PRIMARY KEY, organization_id uuid, is_active boolean);
    CREATE TABLE api_keys(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, key_hash text,
      is_active boolean, deleted_at timestamptz, expires_at timestamptz, rate_limit integer, source_app_id uuid);
    CREATE TABLE user_moderation_status(user_id uuid, status text, total_violations integer);
    CREATE TABLE user_identities(user_id uuid, steward_user_id text, expires_at timestamptz, is_anonymous boolean);
  `);
  for (const name of [
    "organization_subscription_authorities",
    "organization_entitlements",
    "billing_subscriptions",
    "billing_subscription_revisions",
    "subscription_grants",
    "org_rate_limit_overrides",
    "organization_config",
    "organization_payment_reversal_holds",
    "subscription_allowance_periods",
  ])
    await client.exec(`CREATE TABLE ${name}(organization_id uuid)`);
  await client.exec(`
    INSERT INTO organizations(id,is_active,account_lifecycle_state) VALUES
      ('${ORG}',true,'active'),('${OTHER}',true,'active');
    INSERT INTO api_keys(id,organization_id,key_hash,is_active,rate_limit) VALUES ('${KEY}','${ORG}','h',true,100);
  `);
  for (const tag of ["0545_inference_policy_mutation_fences", "0552_inference_rate_policy_fences"])
    for (const statement of readFileSync(
      join(import.meta.dir, "../../db/migrations", `${tag}.sql`),
      "utf8",
    ).split("--> statement-breakpoint"))
      if (statement.trim()) await client.exec(statement);
  helpers = await import("../../db/helpers");
  fence = await import("./inference-policy-fence");
  cloudBindings = await import("../runtime/cloud-bindings");
}, 120_000);

afterEach(() => {
  calls = [];
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("rate-only enrollment", () => {
  test("is refused while the flag is off", async () => {
    await expect(
      withFlags(() => fence.enableInferenceRatePolicyAdmission(ORG), false),
    ).rejects.toThrow("disabled");
    expect(calls).toHaveLength(0);
  });

  test("blocks the object, enrolls rate only, and publishes the advanced epoch after commit", async () => {
    await withFlags(() => fence.enableInferenceRatePolicyAdmission(ORG));
    expect(await authority(ORG)).toEqual({ enabled: false, rate_enabled: true, epoch: "1" });
    expect(calls.map((call) => [call.name, call.path])).toEqual([
      [ORG, "/policy-mutation/begin"],
      [ORG, "/policy-mutation/commit"],
    ]);
    expect(calls[1]?.body.fenceToken).toBe(`token-${String(calls[0]?.body.mutationId)}`);
  });

  test("a later key cap change takes a permit and advances the epoch", async () => {
    await withFlags(() =>
      fence.withInferencePolicyMutation({ organizationIds: [ORG] }, async (tx) => {
        await tx.execute(sql`UPDATE api_keys SET rate_limit = 3 WHERE id = ${KEY}::uuid`);
      }),
    );
    expect(await authority(ORG)).toEqual({ enabled: false, rate_enabled: true, epoch: "2" });
    expect(calls.map((call) => call.path)).toEqual([
      "/policy-mutation/begin",
      "/policy-mutation/commit",
    ]);
  });

  test("an unwrapped write is refused by the primary, even with the flag off", async () => {
    for (const ratePolicy of [true, false])
      await expect(
        withFlags(
          () =>
            helpers.writeTransaction(async (tx) => {
              await tx.execute(sql`UPDATE api_keys SET rate_limit = 4 WHERE id = ${KEY}::uuid`);
            }),
          ratePolicy,
        ),
      ).rejects.toThrow();
    expect(await authority(ORG)).toMatchObject({ epoch: "2" });
  });

  test("other tenants are not fenced or published", async () => {
    await withFlags(() =>
      fence.withInferencePolicyMutation({ organizationIds: [OTHER] }, async (tx) => {
        await tx.execute(
          sql`UPDATE organizations SET settings = '{"a":1}'::jsonb WHERE id = ${OTHER}::uuid`,
        );
      }),
    );
    expect(calls).toHaveLength(0);
  });

  test("withdrawal is fenced too and leaves funded escrow off", async () => {
    await withFlags(() => fence.disableInferenceRatePolicyAdmission(ORG));
    expect(await authority(ORG)).toEqual({ enabled: false, rate_enabled: false, epoch: "3" });
    expect(calls.slice(0, 2).map((call) => call.path)).toEqual([
      "/policy-mutation/begin",
      "/policy-mutation/commit",
    ]);
  });
});
