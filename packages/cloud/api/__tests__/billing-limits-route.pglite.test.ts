/**
 * Exercises GET /api/v1/billing/limits through the real Hono handler, real
 * Steward session and API-key authentication, and an in-process PGlite
 * database. The fixtures prove tenant scoping, exact quota accounting, source
 * overrides, bigint-safe storage serialization, and fail-closed corrupt data.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const PREVIOUS_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  ENVIRONMENT: process.env.ENVIRONMENT,
  MOCK_REDIS: process.env.MOCK_REDIS,
  CACHE_ENABLED: process.env.CACHE_ENABLED,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  ELIZA_CLOUD_MAX_APPS_PER_ORG: process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG,
};

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ENVIRONMENT = "test";
process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "2";

const STEWARD_SECRET = "billing-limits-route-test-secret-0123456789";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_CORRUPT = "33333333-3333-4333-8333-333333333333";
const ORG_BAD_BALANCE = "44444444-4444-4444-8444-444444444444";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const USER_CORRUPT = "cccccccc-3333-4333-8333-333333333333";
const USER_BAD_BALANCE = "dddddddd-4444-4444-8444-444444444444";
const USER_NO_ORG = "eeeeeeee-5555-4555-8555-555555555555";
const STEWARD_B = `steward-${USER_B}`;
const STEWARD_NO_ORG = `steward-${USER_NO_ORG}`;
const KEY_A = "eliza_billing_limits_route_org_a";
const KEY_STALE_B = "eliza_billing_limits_route_stale_org_b";
const KEY_CORRUPT = "eliza_billing_limits_route_corrupt";
const KEY_BAD_BALANCE = "eliza_billing_limits_route_bad_balance";

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  STEWARD_SESSION_SECRET: STEWARD_SECRET,
  RATE_LIMIT_DISABLED: "true",
  RATE_LIMIT_MULTIPLIER: "100",
} as unknown as AppEnv["Bindings"];

type LimitState = "available" | "at-limit" | "over-limit" | "unavailable";

interface CountedLimitItem {
  source: string;
  state: LimitState;
  used?: number;
  limit?: number;
  reason?: string;
}

interface SandboxLimitItem {
  source: string;
  used?: number;
  nonEagerCreate: { state: LimitState; limit?: number; reason?: string };
  eagerManagedCreate: { state: LimitState; limit?: number; reason?: string };
  state: LimitState;
  nonEagerCreateLimit?: number;
  eagerManagedCreateLimit?: number;
  reason?: string;
}

interface StorageLimitItem {
  source: string;
  state: LimitState;
  bytesUsed?: string;
  bytesLimit?: string;
  reason?: string;
}

interface RateLimitItem {
  source: string;
  state: LimitState;
  completionsRpm?: number;
  embeddingsRpm?: number;
  reason?: string;
}

interface LimitsResponse {
  success: true;
  data: {
    observedAt: string;
    cloudCharacters: CountedLimitItem;
    agentSandboxes: SandboxLimitItem;
    containers: CountedLimitItem;
    apps: CountedLimitItem;
    storage: StorageLimitItem;
    inferenceRateLimits: RateLimitItem;
  };
}

interface ErrorResponse {
  success: false;
  error: string;
  code: string;
}

let app: Hono<AppEnv>;
let closeDb: (() => Promise<void>) | undefined;
let mintStewardTokenFromClaims: typeof import("@/lib/auth/steward-client").mintStewardTokenFromClaims;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function restoreEnv(name: keyof typeof PREVIOUS_ENV): void {
  const value = PREVIOUS_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  const schemas = await import("../../shared/src/db/schemas/index");
  const { closeDatabaseConnectionsForTests, dbWrite } = await import(
    "@/db/client"
  );
  closeDb = closeDatabaseConnectionsForTests;
  const { pushSchemaToTestDb } = await import("@/db/push-schema-for-tests");

  // drizzle-kit's schema differ JSON-stringifies literal defaults. Temporarily
  // supply the decimal form expected for bigint defaults during schema push.
  const previousBigIntToJson = Object.getOwnPropertyDescriptor(
    BigInt.prototype,
    "toJSON",
  );
  Object.defineProperty(BigInt.prototype, "toJSON", {
    configurable: true,
    value(this: bigint) {
      return this.toString(10);
    },
  });
  try {
    await pushSchemaToTestDb({
      organizations: schemas.organizations,
      users: schemas.users,
      userIdentities: schemas.userIdentities,
      apiKeys: schemas.apiKeys,
      userCharacters: schemas.userCharacters,
      agentSandboxes: schemas.agentSandboxes,
      organizationConfig: schemas.organizationConfig,
      containers: schemas.containers,
      creditTransactions: schemas.creditTransactions,
      orgRateLimitOverrides: schemas.orgRateLimitOverrides,
      orgStorageQuota: schemas.orgStorageQuota,
      apps: schemas.apps,
      appDeploymentStatusEnum: schemas.appDeploymentStatusEnum,
      appReviewStatusEnum: schemas.appReviewStatusEnum,
      userDatabaseStatusEnum: schemas.userDatabaseStatusEnum,
    });
  } finally {
    if (previousBigIntToJson) {
      Object.defineProperty(BigInt.prototype, "toJSON", previousBigIntToJson);
    } else {
      Reflect.deleteProperty(BigInt.prototype, "toJSON");
    }
  }

  await dbWrite.insert(schemas.organizations).values([
    {
      id: ORG_A,
      name: "Billing Limits Org A",
      slug: "billing-limits-org-a",
      credit_balance: "25",
      settings: { max_agents: 3 },
    },
    {
      id: ORG_B,
      name: "Billing Limits Org B",
      slug: "billing-limits-org-b",
      credit_balance: "0.5",
    },
    {
      id: ORG_CORRUPT,
      name: "Billing Limits Corrupt Sources",
      slug: "billing-limits-corrupt-sources",
      credit_balance: "25",
    },
    {
      id: ORG_BAD_BALANCE,
      name: "Billing Limits Bad Balance",
      slug: "billing-limits-bad-balance",
      credit_balance: "25",
    },
  ]);

  await dbWrite.insert(schemas.users).values([
    {
      id: USER_A,
      email: "billing-limits-owner-a@test.test",
      organization_id: ORG_A,
      role: "owner",
      steward_user_id: `steward-${USER_A}`,
    },
    {
      id: USER_B,
      email: "billing-limits-viewer-b@test.test",
      organization_id: ORG_B,
      role: "viewer",
      steward_user_id: STEWARD_B,
    },
    {
      id: USER_CORRUPT,
      email: "billing-limits-corrupt@test.test",
      organization_id: ORG_CORRUPT,
      role: "member",
      steward_user_id: `steward-${USER_CORRUPT}`,
    },
    {
      id: USER_BAD_BALANCE,
      email: "billing-limits-bad-balance@test.test",
      organization_id: ORG_BAD_BALANCE,
      role: "member",
      steward_user_id: `steward-${USER_BAD_BALANCE}`,
    },
    {
      id: USER_NO_ORG,
      email: "billing-limits-no-org@test.test",
      organization_id: null,
      role: "viewer",
      steward_user_id: STEWARD_NO_ORG,
    },
  ]);

  await dbWrite.insert(schemas.apiKeys).values([
    {
      name: "billing limits org A",
      key_hash: sha256Hex(KEY_A),
      key_prefix: KEY_A.slice(0, 12),
      organization_id: ORG_A,
      user_id: USER_A,
    },
    {
      name: "billing limits stale org B",
      key_hash: sha256Hex(KEY_STALE_B),
      key_prefix: KEY_STALE_B.slice(0, 12),
      organization_id: ORG_A,
      user_id: USER_B,
    },
    {
      name: "billing limits corrupt sources",
      key_hash: sha256Hex(KEY_CORRUPT),
      key_prefix: KEY_CORRUPT.slice(0, 12),
      organization_id: ORG_CORRUPT,
      user_id: USER_CORRUPT,
    },
    {
      name: "billing limits bad balance",
      key_hash: sha256Hex(KEY_BAD_BALANCE),
      key_prefix: KEY_BAD_BALANCE.slice(0, 12),
      organization_id: ORG_BAD_BALANCE,
      user_id: USER_BAD_BALANCE,
    },
  ]);

  const cloudCharacter = (
    organizationId: string,
    userId: string,
    suffix: string,
    source = "cloud",
  ) => ({
    organization_id: organizationId,
    user_id: userId,
    name: `Limits Character ${suffix}`,
    username: `limits-character-${suffix}`,
    bio: ["PGlite fixture"],
    character_data: {},
    source,
  });

  await dbWrite
    .insert(schemas.userCharacters)
    .values([
      cloudCharacter(ORG_A, USER_A, "a-1"),
      cloudCharacter(ORG_A, USER_A, "a-2"),
      cloudCharacter(ORG_A, USER_A, "a-3"),
      cloudCharacter(ORG_A, USER_A, "a-4"),
      cloudCharacter(ORG_A, USER_A, "a-import", "import"),
      cloudCharacter(ORG_B, USER_B, "b-1"),
    ]);

  await dbWrite.insert(schemas.agentSandboxes).values([
    ...(
      ["pending", "provisioning", "running", "stopped", "sleeping"] as const
    ).map((status) => ({
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: `Limits A ${status}`,
      execution_tier: "dedicated-lazy" as const,
      status,
    })),
    ...(
      ["disconnected", "error", "deletion_pending", "deletion_failed"] as const
    ).map((status) => ({
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: `Limits A terminal ${status}`,
      execution_tier: "dedicated-lazy" as const,
      status,
    })),
    {
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Limits A pool row",
      execution_tier: "dedicated-lazy",
      status: "running",
      pool_status: "unclaimed",
    },
    {
      organization_id: ORG_B,
      user_id: USER_B,
      agent_name: "Limits B running",
      execution_tier: "dedicated-lazy",
      status: "running",
    },
  ]);

  await dbWrite.insert(schemas.organizationConfig).values([
    { organization_id: ORG_A, settings: { max_containers: 2 } },
    { organization_id: ORG_CORRUPT, settings: {} },
  ]);

  // Invalid JSON shapes are impossible through the typed write boundary, so
  // seed them with SQL to exercise the route's untrusted persisted-data guard.
  await dbWrite.execute(sql`
    UPDATE ${schemas.organizations}
    SET settings = ${JSON.stringify(["invalid"])}::jsonb
    WHERE ${schemas.organizations.id} = ${ORG_CORRUPT}
  `);
  await dbWrite.execute(sql`
    UPDATE ${schemas.organizationConfig}
    SET settings = ${JSON.stringify("invalid")}::jsonb
    WHERE ${schemas.organizationConfig.organization_id} = ${ORG_CORRUPT}
  `);

  await dbWrite.insert(schemas.containers).values([
    {
      name: "Limits A running",
      project_name: "limits-a-running",
      organization_id: ORG_A,
      user_id: USER_A,
      status: "running",
    },
    {
      name: "Limits A stopped",
      project_name: "limits-a-stopped",
      organization_id: ORG_A,
      user_id: USER_A,
      status: "stopped",
    },
    {
      name: "Limits A deleting",
      project_name: "limits-a-deleting",
      organization_id: ORG_A,
      user_id: USER_A,
      status: "deleting",
    },
    {
      name: "Limits A deleted",
      project_name: "limits-a-deleted",
      organization_id: ORG_A,
      user_id: USER_A,
      status: "deleted",
    },
    {
      name: "Limits B running",
      project_name: "limits-b-running",
      organization_id: ORG_B,
      user_id: USER_B,
      status: "running",
    },
  ]);

  await dbWrite.insert(schemas.apps).values([
    {
      name: "Limits A App One",
      slug: "limits-a-app-one",
      organization_id: ORG_A,
      created_by_user_id: USER_A,
      app_url: "https://limits-a-one.example.test",
    },
    {
      name: "Limits A App Two",
      slug: "limits-a-app-two",
      organization_id: ORG_A,
      created_by_user_id: USER_A,
      app_url: "https://limits-a-two.example.test",
    },
    {
      name: "Limits B App One",
      slug: "limits-b-app-one",
      organization_id: ORG_B,
      created_by_user_id: USER_B,
      app_url: "https://limits-b-one.example.test",
    },
  ]);

  await dbWrite.insert(schemas.creditTransactions).values({
    organization_id: ORG_A,
    user_id: USER_A,
    amount: "10",
    type: "credit",
    metadata: { type: "stripe_purchase" },
  });
  await dbWrite.insert(schemas.orgRateLimitOverrides).values([
    {
      organization_id: ORG_A,
      completions_rpm: 777,
      note: "Route contract fixture",
    },
    {
      organization_id: ORG_CORRUPT,
      completions_rpm: 0,
      note: "Deliberately corrupt fixture",
    },
  ]);
  await dbWrite.insert(schemas.orgStorageQuota).values([
    {
      organization_id: ORG_A,
      bytes_used: 9_007_199_254_740_993n,
      bytes_limit: 9_007_199_254_740_992n,
    },
    {
      organization_id: ORG_CORRUPT,
      bytes_used: -1n,
      bytes_limit: 5_000_000_000n,
    },
  ]);

  await dbWrite
    .update(schemas.organizations)
    .set({ credit_balance: "NaN" })
    .where(eq(schemas.organizations.id, ORG_BAD_BALANCE));

  ({ mintStewardTokenFromClaims } = await import("@/lib/auth/steward-client"));
  const limitsRoute = (await import("../v1/billing/limits/route")).default;
  app = new Hono<AppEnv>();
  app.route("/api/v1/billing/limits", limitsRoute);
}, 120_000);

afterAll(async () => {
  try {
    if (closeDb) await closeDb();
  } finally {
    for (const name of Object.keys(PREVIOUS_ENV) as Array<
      keyof typeof PREVIOUS_ENV
    >) {
      restoreEnv(name);
    }
  }
});

async function sessionCookie(stewardUserId: string): Promise<string> {
  const minted = await mintStewardTokenFromClaims(
    ENV,
    { userId: stewardUserId, expiration: 0, issuedAt: 0 },
    3600,
  );
  if (!minted) throw new Error("test Steward token mint failed");
  return `steward-token-test=${minted.token}`;
}

async function getLimits(
  options: { key?: string; cookie?: string; queryOrganizationId?: string } = {},
): Promise<Response> {
  const backgroundTasks: Promise<unknown>[] = [];
  const headers = new Headers();
  if (options.key) headers.set("X-API-Key", options.key);
  if (options.cookie) headers.set("Cookie", options.cookie);
  const query = options.queryOrganizationId
    ? `?organizationId=${encodeURIComponent(options.queryOrganizationId)}`
    : "";
  const response = await app.request(
    `/api/v1/billing/limits${query}`,
    { headers },
    ENV,
    {
      waitUntil(promise) {
        backgroundTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
  );
  await Promise.all(backgroundTasks);
  return response;
}

async function readySnapshot(
  response: Response,
): Promise<LimitsResponse["data"]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as LimitsResponse;
  expect(body.success).toBe(true);
  expect(new Date(body.data.observedAt).toISOString()).toBe(
    body.data.observedAt,
  );
  return body.data;
}

describe("GET /api/v1/billing/limits with PGlite", () => {
  test("requires a real authenticated account with an organization", async () => {
    const anonymous = await getLimits();
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()) as ErrorResponse).toEqual({
      success: false,
      error: "Authentication required",
      code: "authentication_required",
    });

    const noOrg = await getLimits({
      cookie: await sessionCookie(STEWARD_NO_ORG),
    });
    expect(noOrg.status).toBe(403);
    expect((await noOrg.json()) as ErrorResponse).toEqual({
      success: false,
      error:
        "This feature requires a full account. Please sign up to continue.",
      code: "access_denied",
    });
  });

  test("reports canonical counted rows, overrides, split sandbox caps, and exact bytes", async () => {
    const data = await readySnapshot(await getLimits({ key: KEY_A }));

    expect(data.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "over-limit",
      used: 4,
      limit: 3,
    });
    expect(data.agentSandboxes).toEqual({
      source: "agent-sandbox-quota",
      used: 5,
      nonEagerCreate: { state: "at-limit", limit: 5 },
      eagerManagedCreate: { state: "available", limit: 100 },
      state: "available",
      nonEagerCreateLimit: 5,
      eagerManagedCreateLimit: 100,
    });
    expect(data.containers).toEqual({
      source: "container-quota",
      state: "at-limit",
      used: 2,
      limit: 2,
    });
    expect(data.apps).toEqual({
      source: "apps-service",
      state: "at-limit",
      used: 2,
      limit: 2,
    });
    expect(data.storage).toEqual({
      source: "org-storage-quota",
      state: "over-limit",
      bytesUsed: "9007199254740993",
      bytesLimit: "9007199254740992",
    });
    expect(data.inferenceRateLimits).toEqual({
      source: "org-rate-limits",
      state: "available",
      completionsRpm: 777,
      embeddingsRpm: 200,
    });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("canCreate");
    expect(serialized).not.toContain("standardRpm");
    expect(serialized).not.toContain("strictRpm");
  });

  test("allows a viewer but ignores a forged query organization", async () => {
    const data = await readySnapshot(
      await getLimits({
        cookie: await sessionCookie(STEWARD_B),
        queryOrganizationId: ORG_A,
      }),
    );

    expect(data.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "available",
      used: 1,
      limit: 5,
    });
    expect(data.agentSandboxes).toEqual({
      source: "agent-sandbox-quota",
      used: 1,
      nonEagerCreate: { state: "available", limit: 5 },
      eagerManagedCreate: { state: "available", limit: 5 },
      state: "available",
      nonEagerCreateLimit: 5,
      eagerManagedCreateLimit: 5,
    });
    expect(data.containers).toEqual({
      source: "container-quota",
      state: "at-limit",
      used: 1,
      limit: 1,
    });
    expect(data.apps).toEqual({
      source: "apps-service",
      state: "available",
      used: 1,
      limit: 2,
    });
    expect(data.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "0",
      bytesLimit: "5368709120",
    });
    expect(data.inferenceRateLimits).toEqual({
      source: "org-rate-limits",
      state: "available",
      completionsRpm: 60,
      embeddingsRpm: 100,
    });
  });

  test("uses current user membership over a stale API-key org and forged query", async () => {
    const data = await readySnapshot(
      await getLimits({ key: KEY_STALE_B, queryOrganizationId: ORG_A }),
    );
    expect(data.cloudCharacters.used).toBe(1);
    expect(data.apps.used).toBe(1);
    expect(data.storage.bytesUsed).toBe("0");
  });

  test("marks corrupt persisted numeric and config authorities unavailable", async () => {
    const data = await readySnapshot(await getLimits({ key: KEY_CORRUPT }));

    for (const item of [
      data.cloudCharacters,
      data.containers,
      data.storage,
      data.inferenceRateLimits,
    ]) {
      expect(item.state).toBe("unavailable");
      expect(item.reason).toBeTruthy();
    }
    expect(data.agentSandboxes.nonEagerCreate.state).toBe("available");
    expect(data.agentSandboxes.eagerManagedCreate.state).toBe("available");
    expect(data.apps.state).toBe("available");
  });

  test("marks a malformed app-cap configuration unavailable instead of using the default", async () => {
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "1abc";
    try {
      const data = await readySnapshot(await getLimits({ key: KEY_A }));
      expect(data.apps).toEqual({
        source: "apps-service",
        state: "unavailable",
        reason: "source read failed",
      });
      expect(data.cloudCharacters.state).toBe("over-limit");
      expect(data.containers.state).toBe("at-limit");
      expect(data.storage.state).toBe("over-limit");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("a container quota error is unavailable instead of fabricated as a zero cap", async () => {
    const data = await readySnapshot(await getLimits({ key: KEY_BAD_BALANCE }));

    expect(data.cloudCharacters).toMatchObject({
      state: "unavailable",
      reason: expect.any(String),
    });
    expect(data.agentSandboxes.nonEagerCreate).toEqual({
      state: "available",
      limit: 5,
    });
    expect(data.agentSandboxes.eagerManagedCreate).toMatchObject({
      state: "unavailable",
      reason: expect.any(String),
    });
    expect(data.containers).toMatchObject({
      source: "container-quota",
      state: "unavailable",
      reason: expect.any(String),
    });
    expect(data.containers.used).toBeUndefined();
    expect(data.containers.limit).toBeUndefined();
    expect(data.apps.state).toBe("available");
    expect(data.storage.state).toBe("available");
    expect(data.inferenceRateLimits.state).toBe("available");
  });
});
