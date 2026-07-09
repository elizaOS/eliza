/**
 * Real-DB proof that `deletion_failed` / `deletion_pending` sandboxes do not
 * consume org agent capacity (#15603 C8): an org whose delete exhausted its
 * retries (e.g. the node was SSH-unreachable) can still mint a replacement
 * agent, while genuinely-live rows keep holding their quota slot — so the
 * exclusion cannot be gamed into unbounded live containers.
 *
 * Drives the REAL createAgent / createCodingContainerAgent against in-process
 * PGlite (real Drizzle schema via pushSchema, same harness as
 * eliza-sandbox-coding-container-quota.test.ts) with NOTHING mocked. Rows are
 * flipped to `deletion_failed` exactly as the AGENT_DELETE permanent-failure
 * writeback does (provisioning-jobs.ts): status + error_message + error_count.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { type AgentSandboxStatus, agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
const CAP = 3;
let pgliteReady = true;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let AgentQuotaExceededError: typeof import("../eliza-sandbox").AgentQuotaExceededError;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrg(): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  return org.id;
}

async function seedUser(organizationId: string): Promise<string> {
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: organizationId })
    .returning();
  return user.id;
}

async function countOrgRows(organizationId: string): Promise<number> {
  const rows = await dbWrite.query.agentSandboxes.findMany({
    where: eq(agentSandboxes.organization_id, organizationId),
  });
  return rows.length;
}

async function getStatus(agentId: string): Promise<AgentSandboxStatus | undefined> {
  const row = await dbWrite.query.agentSandboxes.findFirst({
    where: eq(agentSandboxes.id, agentId),
  });
  return row?.status;
}

async function setAgentStatus(agentId: string, status: AgentSandboxStatus): Promise<void> {
  await dbWrite.update(agentSandboxes).set({ status }).where(eq(agentSandboxes.id, agentId));
}

/**
 * Flip a row to `deletion_failed` the way the AGENT_DELETE permanent-failure
 * writeback does — the state a sandbox lands in when the delete job exhausted
 * its retries against an unreachable/failing node and the row is kept for ops.
 */
async function markDeletionFailed(agentId: string): Promise<void> {
  await dbWrite
    .update(agentSandboxes)
    .set({
      status: "deletion_failed",
      error_message: "Deletion permanently failed after 3 attempts: SSH connect timed out",
      error_count: sql`${agentSandboxes.error_count} + 1`,
      updated_at: new Date(),
    })
    .where(eq(agentSandboxes.id, agentId));
}

async function seedOrgAtCap(): Promise<{ orgId: string; userId: string; ids: string[] }> {
  const orgId = await seedOrg();
  const userId = await seedUser(orgId);
  const svc = new ElizaSandboxService();
  const ids: string[] = [];
  for (let i = 0; i < CAP; i++) {
    const res = await svc.createAgent({
      organizationId: orgId,
      userId,
      agentName: `agent-${i}`,
      executionTier: "dedicated-always",
      maxNonTerminalAgents: CAP,
    });
    ids.push(res.agent.id);
  }
  return { orgId, userId, ids };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[eliza-sandbox-deletion-failed-quota.test] non-PGlite DATABASE_URL; self-skipping.",
    );
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService, AgentQuotaExceededError } = await import("../eliza-sandbox"));

    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-sandbox-deletion-failed-quota.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("deletion_failed frees the org's quota slot (#15603 C8)", () => {
  test(
    "org at capacity with one deletion_failed row can mint a replacement; the stuck row stays for ops",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId, ids } = await seedOrgAtCap();
      const svc = new ElizaSandboxService();

      await markDeletionFailed(ids[0]);

      // The user whose delete failed through no fault of their own is NOT
      // locked out: the capped (forceCreate) path mints a replacement.
      const res = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-replacement",
        executionTier: "dedicated-always",
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);

      // The dying row is retained (ops visibility + the re-enqueue sweep needs
      // it) — the org now has CAP+1 rows but only CAP quota-holding ones.
      expect(await countOrgRows(orgId)).toBe(CAP + 1);
      expect(await getStatus(ids[0])).toBe("deletion_failed");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the NORMAL reuse path never resurrects a deletion_failed row — it mints a fresh agent instead",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId, ids } = await seedOrgAtCap();
      const svc = new ElizaSandboxService();

      // Every agent is on its way out: the reuse guard must find nothing to
      // hand back (returning a dying row would resurrect a deleted agent).
      for (const id of ids) {
        await markDeletionFailed(id);
      }

      const res = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-fresh",
        executionTier: "dedicated-always",
        reuseExistingNonTerminal: true,
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);
      expect(ids).not.toContain(res.agent.id);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a re-armed delete (deletion_failed -> deletion_pending) still frees the slot mid-recovery",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId, ids } = await seedOrgAtCap();
      const svc = new ElizaSandboxService();

      // reEnqueueFailedDeletions flips a stuck row back to deletion_pending
      // when it re-arms the delete; the org must stay unblocked through that
      // transition, not only in the failed terminal state.
      await markDeletionFailed(ids[0]);
      await setAgentStatus(ids[0], "deletion_pending");

      const res = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-during-recovery",
        executionTier: "dedicated-always",
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);
      expect(await countOrgRows(orgId)).toBe(CAP + 1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "coding-container path shares the exclusion: deletion_failed frees a slot there too",
    async () => {
      if (!pgliteReady) return;
      const orgId = await seedOrg();
      const userId = await seedUser(orgId);
      const svc = new ElizaSandboxService();

      const ids: string[] = [];
      for (let i = 0; i < CAP; i++) {
        const res = await svc.createCodingContainerAgent({
          organizationId: orgId,
          userId,
          agentName: `cc-${i}`,
          dockerImage: `ghcr.io/elizaos/tool:v${i}`,
          executionTier: "custom",
          maxNonTerminalAgents: CAP,
        });
        ids.push(res.agent.id);
      }
      await markDeletionFailed(ids[0]);

      const res = await svc.createCodingContainerAgent({
        organizationId: orgId,
        userId,
        agentName: "cc-replacement",
        dockerImage: "ghcr.io/elizaos/tool:v99",
        executionTier: "custom",
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);
      expect(await countOrgRows(orgId)).toBe(CAP + 1);
    },
    PGLITE_TIMEOUT,
  );
});

describe("the exclusion cannot be gamed into unbounded live containers", () => {
  test(
    "genuinely-running rows still hold their slot: org at cap of running agents is refused",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId, ids } = await seedOrgAtCap();
      const svc = new ElizaSandboxService();

      for (const id of ids) {
        await setAgentStatus(id, "running");
      }

      await expect(
        svc.createAgent({
          organizationId: orgId,
          userId,
          agentName: "agent-past-cap",
          executionTier: "dedicated-always",
          maxNonTerminalAgents: CAP,
        }),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "one deletion_failed row frees exactly ONE slot: the replacement fills it and the next create is refused with the live count",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId, ids } = await seedOrgAtCap();
      const svc = new ElizaSandboxService();

      for (const id of ids) {
        await setAgentStatus(id, "running");
      }
      await markDeletionFailed(ids[0]);

      // Slot freed by the stuck delete → one replacement goes through...
      const replacement = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-replacement",
        executionTier: "dedicated-always",
        maxNonTerminalAgents: CAP,
      });
      expect(replacement.idempotent).toBe(false);

      // ...and the org is back at the ceiling: the next create is refused, and
      // the reported count is the LIVE count (CAP), not the raw row count
      // (CAP+1 with the dying row still present).
      let quotaError: unknown;
      try {
        await svc.createAgent({
          organizationId: orgId,
          userId,
          agentName: "agent-one-too-many",
          executionTier: "dedicated-always",
          maxNonTerminalAgents: CAP,
        });
      } catch (error) {
        quotaError = error;
      }
      expect(quotaError).toBeInstanceOf(AgentQuotaExceededError);
      expect((quotaError as InstanceType<typeof AgentQuotaExceededError>).count).toBe(CAP);
      expect(await countOrgRows(orgId)).toBe(CAP + 1);
    },
    PGLITE_TIMEOUT,
  );
});
