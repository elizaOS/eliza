/**
 * Real-route and real-PGlite coverage for adopting one existing owned
 * Dedicated row as the personal Shared-to-Dedicated migration target. The
 * harness mocks only authentication; selection, marker ownership, quote
 * binding, lifecycle-job idempotency, and tenant isolation use production
 * services and repositories.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type {
  AgentExecutionTier,
  AgentSandboxStatus,
} from "@/db/schemas/agent-sandboxes";
import * as realAuth from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { personalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";
import * as dbHelpersActual from "../../shared/src/db/helpers";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TARGET_A = "cccccccc-1111-4111-8111-111111111111";
const TARGET_B = "cccccccc-2222-4222-8222-222222222222";
const TARGET_C = "cccccccc-3333-4333-8333-333333333333";
const PERSONAL_A = personalSharedAgentId({
  userId: USER_A,
  organizationId: ORG_A,
});
const PERSONAL_B = personalSharedAgentId({
  userId: USER_B,
  organizationId: ORG_B,
});

const currentUser = {
  id: USER_A,
  email: "owner-a@test.test",
  organization_id: ORG_A,
  organization: { id: ORG_A, name: "Org A", is_active: true },
  is_active: true,
  role: "owner",
  telegram_id: null as string | null,
  discord_id: null as string | null,
};

const realAuthSnapshot = { ...realAuth };
const dbHelpersSnapshot = { ...dbHelpersActual };
const ENV = { NODE_ENV: "test" } as AppEnv["Bindings"];

let commitAckLossCountdown = 0;

function installCommitAckSeam(): void {
  const realDbWrite = dbHelpersSnapshot.dbWrite;
  const wrappedDbWrite = new Proxy(realDbWrite, {
    get(target, prop, receiver) {
      if (prop === "transaction" && commitAckLossCountdown > 0) {
        return async (...args: Parameters<typeof realDbWrite.transaction>) => {
          commitAckLossCountdown -= 1;
          const committed = await target.transaction(...args);
          if (commitAckLossCountdown === 0) {
            throw new Error("simulated adoption commit-acknowledgment loss");
          }
          return committed;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  mock.module("../../shared/src/db/helpers", () => ({
    ...dbHelpersSnapshot,
    dbWrite: wrappedDbWrite,
  }));
}

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;
let dbWrite: typeof import("@/db/client").dbWrite;
let agentSandboxes: typeof import("@/db/schemas/agent-sandboxes").agentSandboxes;
let jobs: typeof import("@/db/schemas/jobs").jobs;
let organizations: typeof import("@/db/schemas/organizations").organizations;

beforeAll(async () => {
  try {
    mock.module("@/lib/auth", () => ({
      ...realAuthSnapshot,
      requireAuthOrApiKeyWithOrg: mock(async () => ({ user: currentUser })),
    }));
    installCommitAckSeam();

    const client = await import("@/db/client");
    dbWrite = client.dbWrite;
    closeDb = client.closeDatabaseConnectionsForTests;
    ({ organizations } = await import("@/db/schemas/organizations"));
    const { users } = await import("@/db/schemas/users");
    ({ agentSandboxes } = await import("@/db/schemas/agent-sandboxes"));
    ({ jobs } = await import("@/db/schemas/jobs"));

    const { TIER_UPGRADE_TEST_TABLES } = await import(
      "@/lib/services/__tests__/tier-upgrade-pglite-schema"
    );
    for (const ddl of TIER_UPGRADE_TEST_TABLES) await dbWrite.execute(ddl);

    await dbWrite.insert(organizations).values([
      {
        id: ORG_A,
        name: "Org A",
        slug: "org-a-adoption",
        credit_balance: "100",
      },
      {
        id: ORG_B,
        name: "Org B",
        slug: "org-b-adoption",
        credit_balance: "100",
      },
    ]);
    await dbWrite.insert(users).values([
      {
        id: USER_A,
        email: "owner-a@test.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${USER_A}`,
      },
      {
        id: USER_B,
        email: "owner-b@test.test",
        organization_id: ORG_B,
        role: "owner",
        steward_user_id: `steward-${USER_B}`,
      },
    ]);

    const route = (
      await import(
        "../v1/eliza/agents/[agentId]/upgrade-tier/adopt-existing/route"
      )
    ).default;
    app = new Hono<AppEnv>();
    app.route(
      "/api/v1/eliza/agents/:agentId/upgrade-tier/adopt-existing",
      route,
    );
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-adopt-existing-dedicated.test] setup failed",
      error,
    );
  }
}, 120_000);

beforeEach(async () => {
  if (!pgliteReady) return;
  commitAckLossCountdown = 0;
  currentUser.id = USER_A;
  currentUser.email = "owner-a@test.test";
  currentUser.organization_id = ORG_A;
  currentUser.organization = { id: ORG_A, name: "Org A", is_active: true };
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
  await dbWrite
    .update(organizations)
    .set({ credit_balance: "100" })
    .where(eq(organizations.id, ORG_A));
});

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
  mock.module("@/lib/auth", () => realAuthSnapshot);
  mock.module("../../shared/src/db/helpers", () => dbHelpersSnapshot);
});

async function seedCandidate(options: {
  id?: string;
  organizationId?: string;
  userId?: string;
  status?: AgentSandboxStatus;
  executionTier?: AgentExecutionTier;
  agentConfig?: Record<string, unknown>;
  poolOwned?: boolean;
  deleted?: boolean;
  deletionInProgress?: boolean;
}) {
  const id = options.id ?? TARGET_A;
  await dbWrite.insert(agentSandboxes).values({
    id,
    organization_id: options.organizationId ?? ORG_A,
    user_id: options.userId ?? USER_A,
    agent_name: "Existing Dedicated Eliza",
    execution_tier: options.executionTier ?? "dedicated-always",
    status: options.status ?? "error",
    database_status: "ready",
    agent_config: options.agentConfig ?? {},
    pool_status: options.poolOwned ? "unclaimed" : null,
    deleted_at: options.deleted ? new Date("2026-08-25T12:00:00.000Z") : null,
    deletion_attempt_id: options.deletionInProgress
      ? "dddddddd-1111-4111-8111-111111111111"
      : null,
    bridge_url: "http://100.64.12.34:3000",
    headscale_ip: "100.64.12.34",
  });
  return id;
}

function quote(agentId = PERSONAL_A) {
  return app.request(
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier/adopt-existing`,
    { method: "GET" },
    ENV,
  );
}

function confirm(quoteId: string, agentId = PERSONAL_A) {
  return app.request(
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier/adopt-existing`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "adopt_existing_dedicated", quoteId }),
    },
    ENV,
  );
}

async function currentQuoteId(): Promise<string> {
  const response = await quote();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { quoteId: string } };
  return body.data.quoteId;
}

async function rows() {
  return dbWrite.select().from(agentSandboxes);
}

async function targetJobs(targetId: string) {
  return dbWrite.select().from(jobs).where(eq(jobs.agent_id, targetId));
}

describe("GET/POST adopt-existing Dedicated", () => {
  test("scopes selection to the authenticated owner and rejects a cross-org personal id", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ organizationId: ORG_B, userId: USER_B });

    const unavailable = await quote();
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({
      code: "dedicated_adoption_unavailable",
    });

    const crossOrg = await quote(PERSONAL_B);
    expect(crossOrg.status).toBe(404);
    expect(await crossOrg.json()).toMatchObject({ error: "Agent not found" });

    await seedCandidate({
      id: TARGET_B,
      organizationId: ORG_A,
      userId: USER_B,
    });
    const wrongUser = await quote();
    expect(wrongUser.status).toBe(404);
    expect(await wrongUser.json()).toMatchObject({ error: "Agent not found" });
    expect((await rows()).every((row) => row.agent_config !== null)).toBe(true);
    expect(
      (await rows()).every(
        (row) =>
          (row.agent_config as Record<string, unknown>).__agentUpgradedFrom ===
          undefined,
      ),
    ).toBe(true);
  });

  test("returns a non-oracular 404 when no eligible owner row exists", async () => {
    expect(pgliteReady).toBe(true);
    const response = await quote();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_unavailable",
      error: "Agent not found",
    });
  });

  test("fails closed on multiple eligible rows and mutates neither row", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ id: TARGET_A });
    await seedCandidate({ id: TARGET_B, status: "stopped" });

    const response = await quote();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_ambiguous",
    });
    const rejected = await confirm("0".repeat(64));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      code: "dedicated_adoption_ambiguous",
    });
    expect((await rows()).map((row) => row.agent_config)).toEqual([{}, {}]);
    expect(await targetJobs(TARGET_A)).toHaveLength(0);
    expect(await targetJobs(TARGET_B)).toHaveLength(0);
  });

  test("fails closed when multiple rows already claim the same personal source", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      id: TARGET_A,
      status: "error",
      agentConfig: { __agentUpgradedFrom: PERSONAL_A },
    });
    await seedCandidate({
      id: TARGET_B,
      status: "running",
      agentConfig: { __agentUpgradedFrom: PERSONAL_A },
    });

    const response = await quote();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_ambiguous",
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("fails closed when one adopted row and one unmarked row are both eligible", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      id: TARGET_A,
      status: "error",
      agentConfig: { __agentUpgradedFrom: PERSONAL_A },
    });
    await seedCandidate({ id: TARGET_B, status: "stopped" });

    const response = await quote();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_ambiguous",
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("ignores pool-owned and deleted rows when exactly one owner row is eligible", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ id: TARGET_A });
    await seedCandidate({ id: TARGET_B, poolOwned: true });
    await seedCandidate({ id: TARGET_C, deleted: true });

    const response = await quote();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { dedicatedAgentId: string; privateAddress?: string };
    };
    expect(body.data.dedicatedAgentId).toBe(TARGET_A);
    expect(JSON.stringify(body)).not.toContain("100.64.");
    expect(body.data.privateAddress).toBeUndefined();
  });

  test("excludes every non-dedicated-always, deleted, pool, and deletion state", async () => {
    expect(pgliteReady).toBe(true);
    const excluded = [
      { id: "cccccccc-4000-4000-8000-000000000001", executionTier: "shared" },
      {
        id: "cccccccc-4000-4000-8000-000000000002",
        executionTier: "dedicated-lazy",
      },
      { id: "cccccccc-4000-4000-8000-000000000003", executionTier: "custom" },
      { id: "cccccccc-4000-4000-8000-000000000004", poolOwned: true },
      { id: "cccccccc-4000-4000-8000-000000000005", deleted: true },
      {
        id: "cccccccc-4000-4000-8000-000000000006",
        status: "deletion_pending",
        deletionInProgress: true,
      },
      {
        id: "cccccccc-4000-4000-8000-000000000007",
        status: "deletion_failed",
      },
      { id: "cccccccc-4000-4000-8000-000000000008", status: "disconnected" },
    ] satisfies Array<Parameters<typeof seedCandidate>[0]>;
    for (const candidate of excluded) await seedCandidate(candidate);

    const response = await quote();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Agent not found" });
    expect((await rows()).every((row) => row.agent_config !== null)).toBe(true);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("rejects conflicting and incomplete server markers without changing them", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      id: TARGET_A,
      agentConfig: { __agentUpgradedFrom: PERSONAL_B },
    });
    await seedCandidate({
      id: TARGET_B,
      agentConfig: {
        __agentPersonalCutover: {
          mode: "dedicated",
          sourceAgentId: PERSONAL_A,
        },
      },
    });

    const response = await quote();
    expect(response.status).toBe(404);
    const allRows = await rows();
    const conflicting = allRows.find((row) => row.id === TARGET_A);
    const incomplete = allRows.find((row) => row.id === TARGET_B);
    expect(
      (conflicting?.agent_config as Record<string, unknown> | undefined)
        ?.__agentUpgradedFrom,
    ).toBe(PERSONAL_B);
    expect(
      (incomplete?.agent_config as Record<string, unknown> | undefined)
        ?.__agentUpgradedFrom,
    ).toBeUndefined();
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("treats present JSON-null or malformed server markers as ineligible", async () => {
    expect(pgliteReady).toBe(true);
    const configs = [
      { __agentUpgradedFrom: null },
      { __agentUpgradedFrom: { sourceAgentId: PERSONAL_A } },
      { __agentPersonalCutover: null },
      { __agentPersonalCutover: "malformed" },
    ];
    for (const [index, agentConfig] of configs.entries()) {
      await seedCandidate({
        id: `cccccccc-5000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        agentConfig,
      });
    }

    const response = await quote();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_unavailable",
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  for (const status of ["error", "stopped"] as const) {
    test(`adopts and provisions the same ${status} row only after exact confirmation`, async () => {
      expect(pgliteReady).toBe(true);
      await seedCandidate({ status });

      const quoted = await quote();
      expect(quoted.status).toBe(200);
      const quoteBody = (await quoted.json()) as {
        data: {
          quoteId: string;
          dedicatedAgentId: string;
          startsCompute: boolean;
          hourlyRateUsd: number;
          dailyRateUsd: number;
          action: string;
        };
      };
      expect(quoteBody.data).toMatchObject({
        dedicatedAgentId: TARGET_A,
        startsCompute: true,
        hourlyRateUsd: 0.01,
        dailyRateUsd: 0.24,
        action: "adopt_existing_dedicated",
      });
      expect(await targetJobs(TARGET_A)).toHaveLength(0);

      const response = await confirm(quoteBody.data.quoteId);
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        data: { dedicatedAgentId: string; jobId: string; runtime: string };
      };
      expect(body.data).toMatchObject({
        dedicatedAgentId: TARGET_A,
        runtime: "dedicated_pending_cutover",
      });
      expect(body.data.jobId).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(body)).not.toContain("100.64.");

      const allRows = await rows();
      expect(allRows).toHaveLength(1);
      expect(allRows[0]?.id).toBe(TARGET_A);
      expect(
        (allRows[0]?.agent_config as Record<string, unknown> | undefined)
          ?.__agentUpgradedFrom,
      ).toBe(PERSONAL_A);
      expect(
        (allRows[0]?.agent_config as Record<string, unknown> | undefined)
          ?.__agentPersonalCutover,
      ).toBeUndefined();
      expect(await targetJobs(TARGET_A)).toHaveLength(1);
    });
  }

  test("adopts a running row without starting another provision job", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "running" });
    const quoteId = await currentQuoteId();

    const response = await confirm(quoteId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        dedicatedAgentId: TARGET_A,
        status: "running",
        runtime: "dedicated_pending_cutover",
      },
    });
    expect(await targetJobs(TARGET_A)).toHaveLength(0);
    const [target] = await rows();
    expect(
      (target?.agent_config as Record<string, unknown> | undefined)
        ?.__agentUpgradedFrom,
    ).toBe(PERSONAL_A);
    expect(
      (target?.agent_config as Record<string, unknown> | undefined)
        ?.__agentPersonalCutover,
    ).toBeUndefined();
  });

  test("rejects a running target while any exclusive lifecycle job is active", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "running" });
    await dbWrite.insert(jobs).values({
      type: "agent_suspend",
      status: "pending",
      data: {
        agentId: TARGET_A,
        organizationId: ORG_A,
        userId: USER_A,
      },
      agent_id: TARGET_A,
      organization_id: ORG_A,
      user_id: USER_A,
    });
    const quoteId = await currentQuoteId();

    const response = await confirm(quoteId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_quote_changed",
    });
    const [target] = await rows();
    expect(target?.agent_config).toEqual({});
    expect(await targetJobs(TARGET_A)).toHaveLength(1);
  });

  test("recovers a lost COMMIT acknowledgment and still nudges the durable provision job", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "error" });
    const quoteId = await currentQuoteId();
    const { provisioningJobService } = await import(
      "@/lib/services/provisioning-jobs"
    );
    const trigger = spyOn(
      provisioningJobService,
      "triggerImmediate",
    ).mockResolvedValue();
    commitAckLossCountdown = 1;
    try {
      const response = await confirm(quoteId);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        success: true,
        data: { dedicatedAgentId: TARGET_A },
      });
      expect(trigger).toHaveBeenCalledTimes(1);
      const [target] = await rows();
      expect(
        (target?.agent_config as Record<string, unknown> | undefined)
          ?.__agentUpgradedFrom,
      ).toBe(PERSONAL_A);
      expect(await targetJobs(TARGET_A)).toHaveLength(1);
    } finally {
      trigger.mockRestore();
      commitAckLossCountdown = 0;
    }
  });

  test("reattaches idempotently to an already-adopted error row under concurrency", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      status: "error",
      agentConfig: { __agentUpgradedFrom: PERSONAL_A },
    });
    const quoteId = await currentQuoteId();

    const responses = await Promise.all([
      confirm(quoteId),
      confirm(quoteId),
      confirm(quoteId),
    ]);
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    const jobIds = new Set(
      bodies.map((body) => (body as { data: { jobId: string } }).data.jobId),
    );
    expect(jobIds.size).toBe(1);
    expect(await targetJobs(TARGET_A)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  test("rejects quote drift without writing a marker or job", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "error" });
    const quoteId = await currentQuoteId();
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped", lifecycle_revision: 1 })
      .where(eq(agentSandboxes.id, TARGET_A));

    const response = await confirm(quoteId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_quote_changed",
    });
    const [target] = await rows();
    expect(target?.agent_config).toEqual({});
    expect(await targetJobs(TARGET_A)).toHaveLength(0);
  });

  test("binds quote identity, balance, and pricing and rejects every drift dimension", async () => {
    expect(pgliteReady).toBe(true);
    const originalPricing = {
      hourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      minimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
    };

    const cases: Array<{
      name: string;
      mutate: () => Promise<void>;
      restore?: () => Promise<void> | void;
    }> = [
      {
        name: "candidate id",
        mutate: async () => {
          await dbWrite
            .delete(agentSandboxes)
            .where(eq(agentSandboxes.id, TARGET_A));
          await seedCandidate({ id: TARGET_B });
        },
      },
      {
        name: "status",
        mutate: async () => {
          await dbWrite
            .update(agentSandboxes)
            .set({ status: "stopped" })
            .where(eq(agentSandboxes.id, TARGET_A));
        },
      },
      {
        name: "lifecycle revision",
        mutate: async () => {
          await dbWrite
            .update(agentSandboxes)
            .set({ lifecycle_revision: 1 })
            .where(eq(agentSandboxes.id, TARGET_A));
        },
      },
      {
        name: "balance",
        mutate: async () => {
          await dbWrite
            .update(organizations)
            .set({ credit_balance: "99" })
            .where(eq(organizations.id, ORG_A));
        },
        restore: async () => {
          await dbWrite
            .update(organizations)
            .set({ credit_balance: "100" })
            .where(eq(organizations.id, ORG_A));
        },
      },
      {
        name: "hourly pricing",
        mutate: async () => {
          Reflect.set(
            AGENT_PRICING,
            "RUNNING_HOURLY_RATE",
            originalPricing.hourlyRate + 0.01,
          );
        },
        restore: () => {
          Reflect.set(
            AGENT_PRICING,
            "RUNNING_HOURLY_RATE",
            originalPricing.hourlyRate,
          );
        },
      },
      {
        name: "minimum runway pricing",
        mutate: async () => {
          Reflect.set(
            AGENT_PRICING,
            "UPGRADE_MIN_HOSTING_DAYS",
            originalPricing.minimumRunwayDays + 1,
          );
        },
        restore: () => {
          Reflect.set(
            AGENT_PRICING,
            "UPGRADE_MIN_HOSTING_DAYS",
            originalPricing.minimumRunwayDays,
          );
        },
      },
    ];

    for (const drift of cases) {
      await dbWrite.delete(jobs);
      await dbWrite.delete(agentSandboxes);
      await seedCandidate({ status: "error" });
      const quoteId = await currentQuoteId();
      try {
        await drift.mutate();
        const response = await confirm(quoteId);
        expect(response.status, drift.name).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "dedicated_adoption_quote_changed",
        });
        expect(
          (await rows()).every(
            (row) =>
              (row.agent_config as Record<string, unknown>)
                .__agentUpgradedFrom === undefined,
          ),
        ).toBe(true);
        expect(await dbWrite.select().from(jobs)).toHaveLength(0);
      } finally {
        await drift.restore?.();
      }
    }
  });

  test("revalidates balance and pricing inside the locked write transaction", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "error" });
    const { adoptPersonalDedicatedTargetWithProvision } = await import(
      "@/lib/services/agent-tier-upgrade-target"
    );
    const base = {
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: PERSONAL_A,
      expectedTargetId: TARGET_A,
      expectedLifecycleRevision: 0,
      expectedStatus: "error" as const,
      expectedBalance: 100,
      expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
      expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
      expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
    };

    await expect(
      adoptPersonalDedicatedTargetWithProvision({
        ...base,
        expectedBalance: 99,
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
    });
    for (const stalePricing of [
      { expectedHourlyRate: base.expectedHourlyRate + 0.01 },
      { expectedDailyRate: base.expectedDailyRate + 0.01 },
      { expectedMinimumBalance: base.expectedMinimumBalance + 0.01 },
      { expectedMinimumRunwayDays: base.expectedMinimumRunwayDays + 1 },
    ]) {
      await expect(
        adoptPersonalDedicatedTargetWithProvision({
          ...base,
          ...stalePricing,
        }),
      ).rejects.toMatchObject({
        code: "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
      });
    }

    const [target] = await rows();
    expect(target?.agent_config).toEqual({});
    expect(await targetJobs(TARGET_A)).toHaveLength(0);
  });

  test("revalidates status and lifecycle for an already-adopted row", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      status: "stopped",
      agentConfig: { __agentUpgradedFrom: PERSONAL_A },
    });
    const { adoptPersonalDedicatedTargetWithProvision } = await import(
      "@/lib/services/agent-tier-upgrade-target"
    );

    await expect(
      adoptPersonalDedicatedTargetWithProvision({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: PERSONAL_A,
        expectedTargetId: TARGET_A,
        expectedLifecycleRevision: 0,
        expectedStatus: "error",
        expectedBalance: 100,
        expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
        expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
        expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
        expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_ADOPTION_QUOTE_CHANGED",
    });
    expect(await targetJobs(TARGET_A)).toHaveLength(0);
  });

  test("rolls the server marker back when transactional enqueue rejects", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "error" });
    const quoteId = await currentQuoteId();
    const { provisioningJobService } = await import(
      "@/lib/services/provisioning-jobs"
    );
    const enqueue = spyOn(
      provisioningJobService,
      "enqueueAgentProvisionOnceInTx",
    );
    enqueue.mockImplementationOnce(async () => {
      throw new Error("simulated adoption enqueue rejection");
    });
    try {
      const response = await confirm(quoteId);
      expect(response.status).toBe(500);
      const [target] = await rows();
      expect(target?.agent_config).toEqual({});
      expect(await targetJobs(TARGET_A)).toHaveLength(0);
    } finally {
      enqueue.mockRestore();
    }
  });

  test("requires a strict explicit confirmation and leaves Shared authoritative", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({ status: "running" });

    const response = await app.request(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_A)}/upgrade-tier/adopt-existing`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "activate_dedicated",
          quoteId: "0".repeat(64),
        }),
      },
      ENV,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "dedicated_adoption_confirmation_required",
    });
    const [target] = await rows();
    expect(target?.agent_config).toEqual({});

    const { findActivePersonalDedicatedTarget } = await import(
      "@/lib/services/agent-tier-upgrade-target"
    );
    expect(
      await findActivePersonalDedicatedTarget(ORG_A, USER_A, PERSONAL_A),
    ).toBeNull();
  });

  test("active personal lookup requires exact user ownership as well as org and markers", async () => {
    expect(pgliteReady).toBe(true);
    await seedCandidate({
      status: "running",
      userId: USER_B,
      agentConfig: {
        __agentUpgradedFrom: PERSONAL_A,
        __agentPersonalCutover: {
          mode: "dedicated",
          sourceAgentId: PERSONAL_A,
          conversationId: PERSONAL_A,
          cutoverToken: "server-cutover-token",
          sharedMessageCount: 0,
          sharedScheduledTaskCount: 0,
          sharedTodoCount: 0,
          sharedTodoMutationCount: 0,
          sharedTodoDigest: "0".repeat(64),
          activatedAt: "2026-08-25T12:00:00.000Z",
        },
      },
    });
    const { findActivePersonalDedicatedTarget } = await import(
      "@/lib/services/agent-tier-upgrade-target"
    );
    expect(
      await findActivePersonalDedicatedTarget(ORG_A, USER_A, PERSONAL_A),
    ).toBeNull();
  });
});
