/**
 * POST /api/v1/eliza/agents/:agentId/upgrade-tier — the shared→dedicated tier
 * upgrade contract (#15355): org-scoped ownership (cross-org reads as 404, no
 * oracle), shared-tier-only validation, the N-days-of-hosting credit runway
 * gate with the canonical 402 body carrying the stricter threshold, the
 * server-side identity copy (name / character / config / BYO env minus
 * platform-reserved keys) onto a dedicated-always target with a provisioning
 * job, and reattach idempotency (a retry resumes the SAME in-flight target;
 * a marker forged onto a non-dedicated row is never reattached to).
 *
 * Real route module + real sandbox/billing/provisioning services + real
 * repositories against in-process PGlite; the only mocked seam is
 * `requireAuthOrApiKeyWithOrg` (same pattern as eliza-agents-restore-body-guard).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as realAuth from "@/lib/auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-1111-4111-8111-111111111111";
const CHARACTER_A = "eeeeeeee-1111-4111-8111-111111111111";
const SHARED_A = "cccccccc-1111-4111-8111-111111111111";
const SHARED_A_STOPPED = "cccccccc-3333-4333-8333-333333333333";
const DEDICATED_A = "cccccccc-4444-4444-8444-444444444444";
const SHARED_RESUME = "cccccccc-7777-4777-8777-777777777777";
const STOPPED_TARGET = "cccccccc-8888-4888-8888-888888888888";
const SLEEPING_TARGET = "cccccccc-9999-4999-8999-999999999999";
const SHARED_CONCURRENT = "cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHARED_B = "cccccccc-2222-4222-8222-222222222222";
const MISSING = "dddddddd-9999-4999-8999-999999999999";
const ORG_FULL = "33333333-3333-4333-8333-333333333333";
const USER_FULL = "bbbbbbbb-2222-4222-8222-222222222222";
const SHARED_FULL = "cccccccc-ffff-4fff-8fff-ffffffffffff";

// Caller identity is switchable so the cross-org denial path is exercised for
// real (org A's user probing org B's agent).
const currentUser = {
  id: USER_A,
  email: "owner-a@test.test",
  organization_id: ORG_A,
  organization: { id: ORG_A, name: "Org A", is_active: true },
  is_active: true,
  role: "owner",
};

// VALUE snapshot at module evaluation + mock installed in beforeAll — never at
// module scope: `bun test` evaluates every test file's module scope up front,
// so a module-scope mock would patch the shared auth module under every OTHER
// suite in a multi-file run (the coverage lane co-runs changed suites, #15943).
const realAuthSnapshot = { ...realAuth };

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

async function setOrgBalance(orgId: string, balance: string): Promise<void> {
  const { dbWrite } = await import("@/db/client");
  const { organizations } = await import("@/db/schemas/organizations");
  await dbWrite
    .update(organizations)
    .set({ credit_balance: balance })
    .where(eq(organizations.id, orgId));
}

beforeAll(async () => {
  try {
    mock.module("@/lib/auth", () => ({
      ...realAuthSnapshot,
      requireAuthOrApiKeyWithOrg: mock(async () => ({ user: currentUser })),
    }));

    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    // Plain DDL instead of drizzle-kit pushSchema: the coverage lane co-runs
    // every changed suite in ONE bun process, and drizzle-kit answers internal
    // errors there with a silent process.exit(1) that kills the whole run.
    const { TIER_UPGRADE_TEST_TABLES } = await import(
      "@/lib/services/__tests__/tier-upgrade-pglite-schema"
    );
    for (const ddl of TIER_UPGRADE_TEST_TABLES) {
      await dbWrite.execute(ddl);
    }
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");

    await dbWrite.insert(organizations).values([
      // Above the create minimum ($0.10) but BELOW the 3-day hosting runway
      // ($0.72) — the exact gap the upgrade gate exists to close.
      { id: ORG_A, name: "Org A", slug: "org-a", credit_balance: "0.50" },
      { id: ORG_B, name: "Org B", slug: "org-b", credit_balance: "100" },
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
    await dbWrite.insert(userCharacters).values([
      {
        id: CHARACTER_A,
        organization_id: ORG_A,
        user_id: USER_A,
        name: "Aurora",
        bio: ["An autonomous AI agent."],
        character_data: { name: "Aurora", system: "Shared front persona." },
      },
    ]);

    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Aurora Front",
        character_id: CHARACTER_A,
        agent_config: {
          character: { name: "Aurora", system: "Shared front persona." },
          bio: ["An autonomous AI agent."],
        },
        environment_vars: {
          MY_CUSTOM_VAR: "keep-me",
          OPENAI_API_KEY: "sk-byo-test",
          // Platform-owned identity values bound to the SHARED row — the copy
          // must NOT inherit them (the dedicated target mints its own).
          ELIZA_API_TOKEN: "agent_shared_platform_token",
          ELIZA_CLOUD_AGENT_ID: SHARED_A,
        },
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      {
        id: SHARED_A_STOPPED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Broken Shared",
        execution_tier: "shared",
        status: "error",
        database_status: "none",
      },
      {
        id: DEDICATED_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Already Dedicated",
        execution_tier: "dedicated-always",
        status: "running",
        database_status: "none",
      },
      {
        id: SHARED_B,
        organization_id: ORG_B,
        user_id: USER_B,
        agent_name: "Org B Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
    ]);

    const upgradeTierRoute = (
      await import("../v1/eliza/agents/[agentId]/upgrade-tier/route")
    ).default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId/upgrade-tier", upgradeTierRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-upgrade-tier.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
  // Hand the pristine module back to whatever test file runs after this one in
  // the same process — a leaked module mock patches itself into later suites'
  // imports.
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

function upgrade(agentId: string) {
  return app.request(
    `/api/v1/eliza/agents/${agentId}/upgrade-tier`,
    { method: "POST" },
    ENV,
  );
}

describe("POST /api/v1/eliza/agents/:agentId/upgrade-tier", () => {
  test("unknown agent id is a 404", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(MISSING);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Agent not found");
  });

  test("another org's shared agent is indistinguishable from a missing one (404, no oracle)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_B);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Agent not found");
  });

  test("a dedicated agent is refused with a typed 409 (tier validation)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(DEDICATED_A);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_shared_tier");
  });

  test("a non-running shared agent is refused with a typed 409", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_A_STOPPED);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("agent_not_running");
  });

  test("a balance above the create minimum but below the hosting runway is a canonical 402", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      error: string;
      requiredBalance: number;
      currentBalance: number;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("insufficient_credits");
    // The 402 carries the ENFORCED runway threshold ($0.72 = 3 × $0.24/day),
    // not the create/provision minimum ($0.10) — the client renders these.
    expect(body.requiredBalance).toBe(0.72);
    expect(body.currentBalance).toBe(0.5);
    expect(body.error).toContain("3 days of hosting");

    // Nothing was minted on the denied path.
    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const agents = await agentSandboxesRepository.listByOrganization(ORG_A);
    expect(agents.map((a) => a.id).sort()).toEqual(
      [SHARED_A, SHARED_A_STOPPED, DEDICATED_A].sort(),
    );
  });

  test("stopped and sleeping targets cannot restart below the hosting runway", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { jobs } = await import("@/db/schemas/jobs");
    await dbWrite.insert(agentSandboxes).values({
      id: SHARED_RESUME,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Resume Source",
      execution_tier: "shared",
      status: "running",
      database_status: "none",
    });

    for (const [targetId, status] of [
      [STOPPED_TARGET, "stopped"],
      [SLEEPING_TARGET, "sleeping"],
    ] as const) {
      await dbWrite.insert(agentSandboxes).values({
        id: targetId,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: `Resume ${status}`,
        agent_config: { __agentUpgradedFrom: SHARED_RESUME },
        execution_tier: "dedicated-always",
        status,
        database_status: "none",
      });

      const res = await upgrade(SHARED_RESUME);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("insufficient_credits");
      const targetJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.agent_id, targetId));
      expect(targetJobs).toHaveLength(0);

      await dbWrite
        .delete(agentSandboxes)
        .where(eq(agentSandboxes.id, targetId));
    }
  });

  test("funded upgrade mints a dedicated-always target with the identity copied server-side", async () => {
    expect(pgliteReady).toBe(true);
    await setOrgBalance(ORG_A, "10");

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      data: {
        id: string;
        dedicatedAgentId: string;
        sharedAgentId: string;
        agentName: string;
        jobId: string;
        executionTier: string;
      };
      polling: { endpoint: string };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.data.sharedAgentId).toBe(SHARED_A);
    expect(body.data.dedicatedAgentId).not.toBe(SHARED_A);
    expect(body.data.agentName).toBe("Aurora Front");
    expect(body.data.executionTier).toBe("dedicated-always");
    expect(body.data.jobId).toBeTruthy();
    expect(body.polling.endpoint).toBe(`/api/v1/jobs/${body.data.jobId}`);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const dedicated = await agentSandboxesRepository.findByIdAndOrg(
      body.data.dedicatedAgentId,
      ORG_A,
    );
    expect(dedicated).toBeTruthy();
    if (!dedicated) throw new Error("dedicated row missing");

    // Identity copy: name, linked character, character config.
    expect(dedicated.agent_name).toBe("Aurora Front");
    expect(dedicated.character_id).toBe(CHARACTER_A);
    expect(dedicated.execution_tier).toBe("dedicated-always");
    expect(dedicated.status).toBe("pending");
    const config = dedicated.agent_config as Record<string, unknown>;
    expect(config.character).toEqual({
      name: "Aurora",
      system: "Shared front persona.",
    });
    // Reattach marker recorded server-side (reserved namespace — client input
    // can never set it).
    expect(config.__agentUpgradedFrom).toBe(SHARED_A);

    // Env copy: BYO values survive; the shared row's platform-owned identity
    // values were NOT inherited (a fresh ELIZA_API_TOKEN was minted, and the
    // cloud-agent id binds to the NEW record).
    const env = dedicated.environment_vars as Record<string, string>;
    expect(env.MY_CUSTOM_VAR).toBe("keep-me");
    expect(env.OPENAI_API_KEY).toBe("sk-byo-test");
    expect(env.ELIZA_API_TOKEN).toBeTruthy();
    expect(env.ELIZA_API_TOKEN).not.toBe("agent_shared_platform_token");
    expect(env.ELIZA_CLOUD_AGENT_ID).toBe(dedicated.id);

    // The shared source is untouched — the user keeps chatting on it until the
    // client handoff confirms the switch.
    const shared = await agentSandboxesRepository.findByIdAndOrg(
      SHARED_A,
      ORG_A,
    );
    expect(shared?.execution_tier).toBe("shared");
    expect(shared?.status).toBe("running");

    // A real agent_provision job exists for the target.
    const { dbWrite } = await import("@/db/client");
    const { jobs } = await import("@/db/schemas/jobs");
    const jobRows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, dedicated.id));
    expect(jobRows.length).toBe(1);
    expect(jobRows[0]?.type).toBe("agent_provision");
  });

  test("a retry reattaches to the SAME in-flight target instead of minting a second one", async () => {
    expect(pgliteReady).toBe(true);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const before = await agentSandboxesRepository.listByOrganization(ORG_A);
    const target = before.find(
      (a) =>
        (a.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_A,
    );
    expect(target).toBeTruthy();
    if (!target) throw new Error("no in-flight target");

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      created: boolean;
      alreadyInProgress: boolean;
      data: { dedicatedAgentId: string; jobId: string };
    };
    expect(body.created).toBe(false);
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.dedicatedAgentId).toBe(target.id);

    // No second agent row, and still exactly one active provision job.
    const after = await agentSandboxesRepository.listByOrganization(ORG_A);
    expect(after.length).toBe(before.length);
    const { dbWrite } = await import("@/db/client");
    const { jobs } = await import("@/db/schemas/jobs");
    const jobRows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, target.id));
    expect(jobRows.length).toBe(1);
    expect(body.data.jobId).toBe(jobRows[0]?.id ?? "");
  });

  test("concurrent upgrades atomically converge on one target, one job, one credential set", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { jobs } = await import("@/db/schemas/jobs");
    await dbWrite.insert(agentSandboxes).values({
      id: SHARED_CONCURRENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Concurrent Source",
      execution_tier: "shared",
      status: "running",
      database_status: "none",
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => upgrade(SHARED_CONCURRENT)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ data: { dedicatedAgentId: string; jobId: string } }>;
    const targetIds = new Set(bodies.map((body) => body.data.dedicatedAgentId));
    const jobIds = new Set(bodies.map((body) => body.data.jobId));
    expect(targetIds.size).toBe(1);
    expect(jobIds.size).toBe(1);

    const targets = (await dbWrite.select().from(agentSandboxes)).filter(
      (agent) =>
        (agent.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_CONCURRENT,
    );
    expect(targets).toHaveLength(1);
    const targetJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, targets[0]!.id));
    expect(targetJobs).toHaveLength(1);
    expect(targetJobs[0]?.id).toBe([...jobIds][0]);

    // Exactly one credential set: the winner's key is bound to the committed
    // target, and every race loser revoked its own candidate (#15943 — the
    // pre-#16042 route re-minted credentials per loser after a 10s poll).
    const targetKeys = await dbWrite
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.name, `agent-sandbox:${targets[0]!.id}`));
    expect(targetKeys).toHaveLength(1);
    expect(targetKeys[0]?.is_active).toBe(true);
  });

  test("an org at its non-terminal cap gets the typed 429 quota body before any credential is minted", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");

    // Balance 0.80: above the 0.72 hosting-runway gate, below the 1.0 tier
    // boundary → cap = 5. Five live sandboxes (the shared source included)
    // fill the cap, so the upgrade must refuse via the org-serialized quota
    // check in the single-flight service — mapped by the route to 429.
    await dbWrite.insert(organizations).values({
      id: ORG_FULL,
      name: "Org Full",
      slug: "org-full",
      credit_balance: "0.80",
    });
    await dbWrite.insert(users).values({
      id: USER_FULL,
      email: "owner-full@test.test",
      organization_id: ORG_FULL,
      role: "owner",
      steward_user_id: `steward-${USER_FULL}`,
    });
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_FULL,
        organization_id: ORG_FULL,
        user_id: USER_FULL,
        agent_name: "Full Org Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      ...Array.from({ length: 4 }, (_unused, index) => ({
        id: `dddddddd-000${index + 1}-4111-8111-111111111111`,
        organization_id: ORG_FULL,
        user_id: USER_FULL,
        agent_name: `Filler ${index + 1}`,
        execution_tier: "dedicated-always" as const,
        status: "running" as const,
        database_status: "none" as const,
      })),
    ]);

    currentUser.id = USER_FULL;
    currentUser.organization_id = ORG_FULL;
    currentUser.organization = {
      id: ORG_FULL,
      name: "Org Full",
      is_active: true,
    };
    try {
      const res = await upgrade(SHARED_FULL);
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        success: boolean;
        code: string;
        currentAgents: number;
        maxAgents: number;
      };
      expect(body.success).toBe(false);
      expect(body.code).toBe("agent_quota_exceeded");
      expect(body.currentAgents).toBe(5);
      expect(body.maxAgents).toBe(5);

      // Refused in phase 1, BEFORE credential preparation: no target row and
      // no candidate api key were ever minted for this org.
      const orgRows = (await dbWrite.select().from(agentSandboxes)).filter(
        (row) => row.organization_id === ORG_FULL,
      );
      expect(orgRows).toHaveLength(5);
      const orgKeys = (await dbWrite.select().from(apiKeys)).filter(
        (key) => key.organization_id === ORG_FULL,
      );
      expect(orgKeys).toHaveLength(0);
    } finally {
      currentUser.id = USER_A;
      currentUser.organization_id = ORG_A;
      currentUser.organization = { id: ORG_A, name: "Org A", is_active: true };
    }
  });

  test("a RUNNING in-flight target reattaches without a job (client goes straight to handoff)", async () => {
    expect(pgliteReady).toBe(true);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const agents = await agentSandboxesRepository.listByOrganization(ORG_A);
    const target = agents.find(
      (a) =>
        (a.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_A,
    );
    if (!target) throw new Error("no in-flight target");
    await agentSandboxesRepository.update(target.id, { status: "running" });

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alreadyInProgress: boolean;
      data: { dedicatedAgentId: string; status: string; jobId?: string };
    };
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.dedicatedAgentId).toBe(target.id);
    expect(body.data.status).toBe("running");
    expect(body.data.jobId).toBeUndefined();
  });

  test("a forged marker on a shared-tier agent is NOT a live target — fresh mint, never reattach", async () => {
    expect(pgliteReady).toBe(true);

    const SHARED_C = "cccccccc-5555-4555-8555-555555555555";
    const FORGED_SHARED = "cccccccc-6666-4666-8666-666666666666";
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_C,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Second Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      {
        id: FORGED_SHARED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Marker Forgery",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
    ]);
    // Plant the reattach marker on the SHARED row via a config update — the
    // same write shape a config PATCH produces. Tier, not marker, must decide.
    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    await agentSandboxesRepository.update(FORGED_SHARED, {
      agent_config: { __agentUpgradedFrom: SHARED_C },
    });

    const res = await upgrade(SHARED_C);
    // Without the dedicated-always tier check this would 200-reattach onto the
    // forged running shared row; the fresh-mint 202 proves it was ignored.
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      created: boolean;
      data: { dedicatedAgentId: string; executionTier: string };
    };
    expect(body.created).toBe(true);
    expect(body.data.dedicatedAgentId).not.toBe(FORGED_SHARED);
    expect(body.data.executionTier).toBe("dedicated-always");

    // The forged row is untouched: still shared-tier and owns no provision job.
    const forged = await agentSandboxesRepository.findByIdAndOrg(
      FORGED_SHARED,
      ORG_A,
    );
    expect(forged?.execution_tier).toBe("shared");
    const { jobs } = await import("@/db/schemas/jobs");
    const forgedJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, FORGED_SHARED));
    expect(forgedJobs.length).toBe(0);
  });
});
