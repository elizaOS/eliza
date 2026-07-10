/**
 * Real-DB coverage for the tier-upgrade single-flight boundary (#15943):
 * target creation, managed-environment preparation, and provision-job enqueue
 * as one durable unit. Real service + real repositories + real provisioning
 * job service against in-process PGlite; the only instrumented seam is
 * `prepareManagedElizaSharedEnvironment` (wrapped, not replaced — it delegates
 * to the real implementation) so tests can delay or fail the credential-mint
 * phase and prove losers/retries never double-prepare, plus one spy on the
 * enqueue step to prove target+job atomicity under rollback.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq, like } from "drizzle-orm";
import * as managedConfigActual from "./managed-eliza-config";

// ---- instrumented prep seam: delay / fail / count, delegating to the real fn ----
// The namespace import is a LIVE binding that mock.module rewires, so the real
// implementation must be captured by value here or the wrapper would recurse.
const realPrepareManagedElizaSharedEnvironment =
  managedConfigActual.prepareManagedElizaSharedEnvironment;
let prepDelayMs = 0;
let prepFailNext = false;
let prepCalls = 0;

mock.module("./managed-eliza-config", () => ({
  ...managedConfigActual,
  prepareManagedElizaSharedEnvironment: async (
    params: Parameters<typeof realPrepareManagedElizaSharedEnvironment>[0],
  ) => {
    prepCalls += 1;
    if (prepFailNext) {
      prepFailNext = false;
      throw new Error("simulated credential-mint failure");
    }
    if (prepDelayMs > 0) {
      const delay = prepDelayMs;
      prepDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return realPrepareManagedElizaSharedEnvironment(params);
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_QUOTA = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_QUOTA = "bbbbbbbb-1111-4111-8111-111111111111";
const CHARACTER_A = "eeeeeeee-1111-4111-8111-111111111111";
const SRC_BASIC = "cccccccc-1111-4111-8111-111111111111";
const SRC_CONCURRENT = "cccccccc-2222-4222-8222-222222222222";
const SRC_DELAYED = "cccccccc-3333-4333-8333-333333333333";
const SRC_ENQUEUE_FAIL = "cccccccc-4444-4444-8444-444444444444";
const SRC_PREP_FAIL = "cccccccc-5555-4555-8555-555555555555";
const SRC_ADOPTED = "cccccccc-6666-4666-8666-666666666666";
const SRC_QUOTA = "cccccccc-7777-4777-8777-777777777777";
const SRC_FORGED = "cccccccc-8888-4888-8888-888888888888";
const QUOTA_EXISTING = "dddddddd-1111-4111-8111-111111111111";

const PGLITE_TIMEOUT = 120_000;
let pgliteReady = true;

type Db = typeof import("../../db/client").dbWrite;
let dbWrite: Db;
let closeDb: (() => Promise<void>) | undefined;
let agentSandboxes: typeof import("../../db/schemas/agent-sandboxes").agentSandboxes;
let jobs: typeof import("../../db/schemas/jobs").jobs;
let apiKeys: typeof import("../../db/schemas/api-keys").apiKeys;
let svc: typeof import("./agent-tier-upgrade-target");

beforeAll(async () => {
  try {
    const client = await import("../../db/client");
    dbWrite = client.dbWrite;
    closeDb = client.closeDatabaseConnectionsForTests;

    const { organizations } = await import("../../db/schemas/organizations");
    const { users } = await import("../../db/schemas/users");
    const { userCharacters } = await import("../../db/schemas/user-characters");
    ({ agentSandboxes } = await import("../../db/schemas/agent-sandboxes"));
    ({ apiKeys } = await import("../../db/schemas/api-keys"));
    // jobs → generations → usage_records is a pure FK chain; the extra tables
    // exist only so the pushed schema's constraints resolve.
    const { usageRecords } = await import("../../db/schemas/usage-records");
    const { generations } = await import("../../db/schemas/generations");
    ({ jobs } = await import("../../db/schemas/jobs"));
    const { pushSchema } = await import("../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        apiKeys,
        usageRecords,
        generations,
        jobs,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "org-a", credit_balance: "100" },
      { id: ORG_QUOTA, name: "Org Quota", slug: "org-quota", credit_balance: "100" },
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
        id: USER_QUOTA,
        email: "owner-quota@test.test",
        organization_id: ORG_QUOTA,
        role: "owner",
        steward_user_id: `steward-${USER_QUOTA}`,
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
    // Live sandbox that fills ORG_QUOTA's entire cap for the quota test.
    await dbWrite.insert(agentSandboxes).values({
      id: QUOTA_EXISTING,
      organization_id: ORG_QUOTA,
      user_id: USER_QUOTA,
      agent_name: "Quota Filler",
      execution_tier: "dedicated-always",
      status: "running",
      database_status: "none",
    });

    svc = await import("./agent-tier-upgrade-target");
  } catch (error) {
    pgliteReady = false;
    console.error("[agent-tier-upgrade-target.test] setup failed — failing.", error);
  }
}, PGLITE_TIMEOUT);

afterEach(() => {
  prepDelayMs = 0;
  prepFailNext = false;
});

function upgradeParams(sourceAgentId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceAgentId,
    organizationId: ORG_A,
    userId: USER_A,
    agentName: `upgrade-of-${sourceAgentId.slice(0, 8)}`,
    agentConfig: { character: { name: "Aurora" }, __agentUpgradedFrom: "forged-by-caller" },
    environmentVars: { MY_CUSTOM_VAR: "keep-me" },
    maxNonTerminalAgents: 50,
    ...overrides,
  };
}

async function targetsForSource(sourceAgentId: string) {
  const rows = await dbWrite.select().from(agentSandboxes);
  return rows.filter(
    (row) =>
      (row.agent_config as Record<string, unknown> | null)?.__agentUpgradedFrom === sourceAgentId &&
      row.execution_tier === "dedicated-always",
  );
}

async function jobsForAgent(agentId: string) {
  return dbWrite.select().from(jobs).where(eq(jobs.agent_id, agentId));
}

/**
 * Global no-dangling-credentials invariant: every `agent-sandbox:<id>` API key
 * must belong to an EXISTING sandbox row. Candidates minted by losers/failed
 * attempts are revoked, so keys for never-committed ids may not survive.
 */
async function expectNoOrphanAgentKeys() {
  const keyRows = await dbWrite.select().from(apiKeys).where(like(apiKeys.name, "agent-sandbox:%"));
  const sandboxIds = new Set((await dbWrite.select().from(agentSandboxes)).map((row) => row.id));
  for (const key of keyRows) {
    const boundId = key.name.slice("agent-sandbox:".length);
    expect(sandboxIds.has(boundId)).toBe(true);
  }
}

describe("createTierUpgradeTargetWithProvision — durable single-flight boundary", () => {
  test(
    "fresh mint commits target + prepared environment + provision job as one unit, through the canonical builder",
    async () => {
      expect(pgliteReady).toBe(true);

      const result = await svc.createTierUpgradeTargetWithProvision(
        upgradeParams(SRC_BASIC, { characterId: CHARACTER_A }),
      );
      expect(result.created).toBe(true);
      if (!result.created) throw new Error("expected fresh mint");

      const [target] = await targetsForSource(SRC_BASIC);
      expect(target).toBeTruthy();
      expect(target?.id).toBe(result.agent.id);

      // Canonical-builder values: tier→status derivation, defaults, character
      // ownership, and the reserved-namespace strip (the caller-forged marker
      // was dropped; the server marker points at the real source).
      expect(target?.execution_tier).toBe("dedicated-always");
      expect(target?.status).toBe("pending");
      expect(target?.database_status).toBe("none");
      expect(target?.character_id).toBe(CHARACTER_A);
      const config = target?.agent_config as Record<string, unknown>;
      expect(config.__agentUpgradedFrom).toBe(SRC_BASIC);
      expect(config.__agentCharacterOwnership).toBe("reuse-existing");
      expect(config.character).toEqual({ name: "Aurora" });

      // Environment prepared at creation — not patched in afterwards. BYO
      // survives; platform identity binds to the NEW record.
      const env = target?.environment_vars as Record<string, string>;
      expect(env.MY_CUSTOM_VAR).toBe("keep-me");
      expect(env.ELIZA_CLOUD_AGENT_ID).toBe(result.agent.id);
      expect(env.ELIZA_API_TOKEN).toMatch(/^agent_/);

      // The provision job committed with the target.
      const jobRows = await jobsForAgent(result.agent.id);
      expect(jobRows).toHaveLength(1);
      expect(jobRows[0]?.type).toBe("agent_provision");
      expect(jobRows[0]?.status).toBe("pending");
      expect(result.job.id).toBe(jobRows[0]?.id ?? "");

      // Exactly one credential set, bound to the committed target.
      const keyRows = await dbWrite
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, `agent-sandbox:${result.agent.id}`));
      expect(keyRows).toHaveLength(1);
      await expectNoOrphanAgentKeys();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a retry reattaches to durable state without invoking preparation at all",
    async () => {
      expect(pgliteReady).toBe(true);

      const callsBefore = prepCalls;
      const result = await svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_BASIC));
      expect(result.created).toBe(false);
      const [target] = await targetsForSource(SRC_BASIC);
      expect(result.agent.id).toBe(target?.id ?? "");
      // Reattach is read-only: no second preparation, no second job, no key churn.
      expect(prepCalls).toBe(callsBefore);
      expect(await jobsForAgent(result.agent.id)).toHaveLength(1);
      const keyRows = await dbWrite
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, `agent-sandbox:${result.agent.id}`));
      expect(keyRows).toHaveLength(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a burst of concurrent upgrades converges on one target, one job, one credential set",
    async () => {
      expect(pgliteReady).toBe(true);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_CONCURRENT)),
        ),
      );
      const targetIds = new Set(results.map((result) => result.agent.id));
      expect(targetIds.size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);

      const targets = await targetsForSource(SRC_CONCURRENT);
      expect(targets).toHaveLength(1);
      expect(await jobsForAgent(targets[0]!.id)).toHaveLength(1);
      const keyRows = await dbWrite
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, `agent-sandbox:${targets[0]!.id}`));
      expect(keyRows).toHaveLength(1);
      // Losers' candidate credentials (minted for their own prospective ids)
      // were revoked — nothing dangles.
      await expectNoOrphanAgentKeys();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a winner delayed >10s in credential minting yields to the concurrent request and reattaches — exactly one credential/environment mutation and one job",
    async () => {
      expect(pgliteReady).toBe(true);

      // First caller stalls 10.5s inside preparation (longer than the removed
      // 10s job-wait window that used to make losers take over); second caller
      // runs at full speed and commits the durable target+job.
      prepDelayMs = 10_500;
      const delayed = svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_DELAYED));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fast = await svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_DELAYED));
      const late = await delayed;

      expect(fast.created).toBe(true);
      expect(late.created).toBe(false);
      expect(late.agent.id).toBe(fast.agent.id);

      const targets = await targetsForSource(SRC_DELAYED);
      expect(targets).toHaveLength(1);
      const target = targets[0]!;

      // The stalled caller never wrote the winner's row: the environment still
      // binds to the committed target id (a takeover would have stamped the
      // loser's own prospective id), and the row was never updated post-insert.
      const env = target.environment_vars as Record<string, string>;
      expect(env.ELIZA_CLOUD_AGENT_ID).toBe(fast.agent.id);
      expect(target.updated_at?.getTime()).toBe(target.created_at?.getTime() ?? Number.NaN);

      expect(await jobsForAgent(target.id)).toHaveLength(1);
      const keyRows = await dbWrite
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, `agent-sandbox:${target.id}`));
      expect(keyRows).toHaveLength(1);
      await expectNoOrphanAgentKeys();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an enqueue failure rolls the target back with the job and revokes the candidate credentials; the retry converges",
    async () => {
      expect(pgliteReady).toBe(true);
      const { provisioningJobService } = await import("./provisioning-jobs");

      const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentProvisionOnceInTx");
      enqueueSpy.mockImplementationOnce(async () => {
        throw new Error("simulated enqueue failure inside the boundary");
      });
      try {
        await expect(
          svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_ENQUEUE_FAIL)),
        ).rejects.toThrow("simulated enqueue failure inside the boundary");

        // Atomic rollback: no half-created target a cleanup would have to
        // delete, no job, no surviving candidate credentials.
        expect(await targetsForSource(SRC_ENQUEUE_FAIL)).toHaveLength(0);
        await expectNoOrphanAgentKeys();

        // Retry (spy restored to the real implementation) converges cleanly.
        const retry = await svc.createTierUpgradeTargetWithProvision(
          upgradeParams(SRC_ENQUEUE_FAIL),
        );
        expect(retry.created).toBe(true);
        expect(await targetsForSource(SRC_ENQUEUE_FAIL)).toHaveLength(1);
        expect(await jobsForAgent(retry.agent.id)).toHaveLength(1);
        await expectNoOrphanAgentKeys();
      } finally {
        enqueueSpy.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a credential-mint failure leaves nothing durable; the retry converges",
    async () => {
      expect(pgliteReady).toBe(true);

      prepFailNext = true;
      await expect(
        svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_PREP_FAIL)),
      ).rejects.toThrow("simulated credential-mint failure");
      expect(await targetsForSource(SRC_PREP_FAIL)).toHaveLength(0);
      await expectNoOrphanAgentKeys();

      const retry = await svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_PREP_FAIL));
      expect(retry.created).toBe(true);
      expect(await jobsForAgent(retry.agent.id)).toHaveLength(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a failing follow-up request can never remove a committed target owned by a live job (no compensation surface)",
    async () => {
      expect(pgliteReady).toBe(true);

      const minted = await svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_ADOPTED));
      expect(minted.created).toBe(true);
      const jobBefore = await jobsForAgent(minted.agent.id);
      expect(jobBefore).toHaveLength(1);

      // Arm the prep seam to fail — a reattach must return BEFORE preparation,
      // so the armed failure must never fire and nothing durable may change.
      prepFailNext = true;
      const callsBefore = prepCalls;
      const reattach = await svc.createTierUpgradeTargetWithProvision(upgradeParams(SRC_ADOPTED));
      expect(reattach.created).toBe(false);
      expect(reattach.agent.id).toBe(minted.agent.id);
      expect(prepCalls).toBe(callsBefore);
      prepFailNext = false;

      expect(await targetsForSource(SRC_ADOPTED)).toHaveLength(1);
      expect(await jobsForAgent(minted.agent.id)).toHaveLength(1);
      expect((await jobsForAgent(minted.agent.id))[0]?.id).toBe(jobBefore[0]?.id ?? "");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an over-quota upgrade is refused before any credential is minted",
    async () => {
      expect(pgliteReady).toBe(true);
      const { AgentQuotaExceededError } = await import("./eliza-sandbox");

      const callsBefore = prepCalls;
      await expect(
        svc.createTierUpgradeTargetWithProvision(
          upgradeParams(SRC_QUOTA, {
            organizationId: ORG_QUOTA,
            userId: USER_QUOTA,
            maxNonTerminalAgents: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      // Phase-1 refusal: preparation never ran, so no key was minted at all.
      expect(prepCalls).toBe(callsBefore);
      expect(await targetsForSource(SRC_QUOTA)).toHaveLength(0);
      await expectNoOrphanAgentKeys();
    },
    PGLITE_TIMEOUT,
  );
});

describe("findLiveTierUpgradeTarget", () => {
  test(
    "returns the live dedicated target, and never a forged marker on a non-dedicated row",
    async () => {
      expect(pgliteReady).toBe(true);

      const live = await svc.findLiveTierUpgradeTarget(ORG_A, SRC_BASIC);
      expect(live?.id).toBe((await targetsForSource(SRC_BASIC))[0]?.id ?? "");

      // A marker planted on a SHARED row (agent_config is PATCHable) must not
      // read as a migration target — only dedicated-always rows own upgrades.
      const FORGED = "dddddddd-2222-4222-8222-222222222222";
      await dbWrite.insert(agentSandboxes).values({
        id: FORGED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Marker Forgery",
        agent_config: { __agentUpgradedFrom: SRC_FORGED },
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      });
      expect(await svc.findLiveTierUpgradeTarget(ORG_A, SRC_FORGED)).toBeNull();
    },
    PGLITE_TIMEOUT,
  );
});

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});
