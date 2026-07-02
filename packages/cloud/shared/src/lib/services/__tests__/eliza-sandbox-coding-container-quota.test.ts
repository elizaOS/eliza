/**
 * Real-DB proof of the per-org quota on the CODING-CONTAINER create path (#11023).
 *
 * PR #11042 closed the primary fleet-DoS on POST /api/v1/eliza/agents
 * (forceCreate) by capping createAgent's plain-insert branch, but it did NOT
 * touch createCodingContainerAgent — the sibling path behind
 * POST /api/v1/coding-containers. That path's advisory lock + reuse guard are
 * keyed on the EXACT docker_image, so a loop of DISTINCT allowlisted image
 * references (`:v1`/`:v2`/`@sha256…` under an allowlisted namespace) each misses
 * the reuse guard and mints a fresh custom container on the shared fleet — an
 * unbounded per-org DoS (adversarially confirmed 3/3 skeptics, high confidence).
 *
 * The fix gives createCodingContainerAgent the SAME maxNonTerminalAgents cap,
 * counted UNDER the per-org agent-create advisory lock (acquired before the
 * per-image lock so the count is atomic across concurrent distinct-image
 * creates and the two create paths can't deadlock). Over the cap it throws
 * AgentQuotaExceededError, which the route maps to 429.
 *
 * This suite drives the REAL createCodingContainerAgent against in-process
 * PGlite (real Drizzle schema via pushSchema, same harness as
 * app-credit-hold-concurrency.test.ts) with NOTHING mocked. PGlite serializes
 * statements, so the lock-ORDERING property is pinned in
 * eliza-sandbox-create-idempotency.test.ts; this file proves the behavioral
 * quota semantics end-to-end on real SQL.
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
import { eq } from "drizzle-orm";
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

async function setAgentStatus(agentId: string, status: AgentSandboxStatus): Promise<void> {
  await dbWrite.update(agentSandboxes).set({ status }).where(eq(agentSandboxes.id, agentId));
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[eliza-sandbox-coding-container-quota.test] non-PGlite DATABASE_URL; self-skipping.",
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
      "[eliza-sandbox-coding-container-quota.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("createCodingContainerAgent — per-org quota (#11023)", () => {
  test(
    "the distinct-image DoS is dead: 6 distinct-image creates at cap 3 → exactly 3 rows, surplus throw AgentQuotaExceededError",
    async () => {
      if (!pgliteReady) return;
      const orgId = await seedOrg();
      const userId = await seedUser(orgId);
      const svc = new ElizaSandboxService();

      const results = await Promise.allSettled(
        Array.from({ length: CAP * 2 }, (_, i) =>
          svc.createCodingContainerAgent({
            organizationId: orgId,
            userId,
            agentName: `cc-${i}`,
            // DISTINCT image per call — the exact bypass of the per-image lock.
            dockerImage: `ghcr.io/elizaos/tool:v${i}`,
            executionTier: "custom",
            maxNonTerminalAgents: CAP,
          }),
        ),
      );

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won.length).toBe(CAP);
      expect(lost.length).toBe(CAP);
      for (const rejection of lost) {
        expect(rejection.reason).toBeInstanceOf(AgentQuotaExceededError);
      }
      // The DB agrees: the fleet only ever received CAP containers for this org.
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "same-image retry at the cap reuses the active row (idempotent, no throw)",
    async () => {
      if (!pgliteReady) return;
      const orgId = await seedOrg();
      const userId = await seedUser(orgId);
      const svc = new ElizaSandboxService();

      let firstId = "";
      for (let i = 0; i < CAP; i++) {
        const res = await svc.createCodingContainerAgent({
          organizationId: orgId,
          userId,
          agentName: `cc-${i}`,
          dockerImage: `ghcr.io/elizaos/tool:v${i}`,
          executionTier: "custom",
          maxNonTerminalAgents: CAP,
        });
        if (i === 0) firstId = res.agent.id;
      }
      // At the cap, but a SAME-image call returns the existing row (retry) —
      // never a 429, so a client retry loop can't be locked out of its own agent.
      const retry = await svc.createCodingContainerAgent({
        organizationId: orgId,
        userId,
        agentName: "cc-retry",
        dockerImage: "ghcr.io/elizaos/tool:v0",
        executionTier: "custom",
        maxNonTerminalAgents: CAP,
      });
      expect(retry.idempotent).toBe(true);
      expect(retry.agent.id).toBe(firstId);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "unset cap stays uncapped (trusted internal callers) — mints past any ceiling",
    async () => {
      if (!pgliteReady) return;
      const orgId = await seedOrg();
      const userId = await seedUser(orgId);
      const svc = new ElizaSandboxService();

      for (let i = 0; i < CAP + 2; i++) {
        const res = await svc.createCodingContainerAgent({
          organizationId: orgId,
          userId,
          agentName: `cc-internal-${i}`,
          dockerImage: `ghcr.io/elizaos/tool:v${i}`,
          executionTier: "custom",
          // maxNonTerminalAgents intentionally unset
        });
        expect(res.idempotent).toBe(false);
      }
      expect(await countOrgRows(orgId)).toBe(CAP + 2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "quota is per-org: org A at the cap does not block org B",
    async () => {
      if (!pgliteReady) return;
      const orgA = await seedOrg();
      const userA = await seedUser(orgA);
      const orgB = await seedOrg();
      const userB = await seedUser(orgB);
      const svc = new ElizaSandboxService();

      for (let i = 0; i < CAP; i++) {
        await svc.createCodingContainerAgent({
          organizationId: orgA,
          userId: userA,
          agentName: `a-${i}`,
          dockerImage: `ghcr.io/elizaos/tool:v${i}`,
          executionTier: "custom",
          maxNonTerminalAgents: CAP,
        });
      }
      // Org A is capped; org B (fresh) must still be able to create.
      const res = await svc.createCodingContainerAgent({
        organizationId: orgB,
        userId: userB,
        agentName: "b-0",
        dockerImage: "ghcr.io/elizaos/tool:v0",
        executionTier: "custom",
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);
      expect(await countOrgRows(orgB)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "createAgent (forceCreate) and createCodingContainerAgent share ONE per-org ceiling",
    async () => {
      if (!pgliteReady) return;
      const orgId = await seedOrg();
      const userId = await seedUser(orgId);
      const svc = new ElizaSandboxService();

      // Fill the cap via the eliza/agents forceCreate path (#11042)...
      for (let i = 0; i < CAP; i++) {
        await svc.createAgent({
          organizationId: orgId,
          userId,
          agentName: `agent-${i}`,
          executionTier: "dedicated-always",
          maxNonTerminalAgents: CAP,
        });
      }
      // ...then a coding-container create for the SAME org must be refused —
      // the two routes count against the same non-terminal-sandbox pool, so an
      // attacker can't sidestep one route's cap by pivoting to the other.
      await expect(
        svc.createCodingContainerAgent({
          organizationId: orgId,
          userId,
          agentName: "cc-cross",
          dockerImage: "ghcr.io/elizaos/tool:v0",
          executionTier: "custom",
          maxNonTerminalAgents: CAP,
        }),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );
});

/**
 * F3 residual of #11023: `stopped` (suspend keeps the container + node slot +
 * per-tenant managed Postgres) and `sleeping` (cold storage keeps the managed
 * Postgres) retain the org's durable per-agent resources, yet the original
 * quota counted only `pending`/`provisioning`/`running` — so a
 * create→suspend→create loop minted unbounded agents, each a real managed DB.
 * Prong 2: the NORMAL (reuse) create path had no cap at all, and after a
 * suspend there is no live agent for the reuse guard to hand back, so every
 * subsequent normal create inserted a fresh uncapped row.
 */
describe("suspend/sleep quota residual (#11023 F3)", () => {
  test(
    "stopped + sleeping rows still hold their quota slot: both capped create paths throw",
    async () => {
      if (!pgliteReady) return;
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
      // Suspend one, sleep another. Both keep the org's per-tenant managed
      // Postgres (suspend also keeps the container + node slot), so they must
      // keep counting toward the ceiling.
      await setAgentStatus(ids[0], "stopped");
      await setAgentStatus(ids[1], "sleeping");

      await expect(
        svc.createAgent({
          organizationId: orgId,
          userId,
          agentName: "agent-past-cap",
          executionTier: "dedicated-always",
          maxNonTerminalAgents: CAP,
        }),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      await expect(
        svc.createCodingContainerAgent({
          organizationId: orgId,
          userId,
          agentName: "cc-past-cap",
          dockerImage: "ghcr.io/elizaos/tool:v99",
          executionTier: "custom",
          maxNonTerminalAgents: CAP,
        }),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the create→suspend→create loop is dead: the NORMAL reuse path throws when every existing agent is suspended/sleeping",
    async () => {
      if (!pgliteReady) return;
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
      // Suspend/sleep EVERYTHING: the reuse guard now has no live agent to
      // hand back, so pre-fix the normal path fell through to an uncapped
      // insert — one fresh agent (and managed DB) per loop iteration.
      for (const [i, id] of ids.entries()) {
        await setAgentStatus(id, i % 2 === 0 ? "stopped" : "sleeping");
      }

      await expect(
        svc.createAgent({
          organizationId: orgId,
          userId,
          agentName: "agent-loop",
          executionTier: "dedicated-always",
          reuseExistingNonTerminal: true,
          maxNonTerminalAgents: CAP,
        }),
      ).rejects.toBeInstanceOf(AgentQuotaExceededError);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "reuse semantics unchanged: at the cap a LIVE agent is still handed back (never a suspended row, never a throw)",
    async () => {
      if (!pgliteReady) return;
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
      await setAgentStatus(ids[0], "stopped");

      const res = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-reuse",
        executionTier: "dedicated-always",
        reuseExistingNonTerminal: true,
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(true);
      expect(res.agent.id).not.toBe(ids[0]);
      expect(await countOrgRows(orgId)).toBe(CAP);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "terminal states stay excluded: error / deletion_pending rows free their quota slot",
    async () => {
      if (!pgliteReady) return;
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
      await setAgentStatus(ids[0], "error");
      await setAgentStatus(ids[1], "deletion_pending");

      const res = await svc.createAgent({
        organizationId: orgId,
        userId,
        agentName: "agent-after-terminal",
        executionTier: "dedicated-always",
        maxNonTerminalAgents: CAP,
      });
      expect(res.idempotent).toBe(false);
      expect(await countOrgRows(orgId)).toBe(CAP + 1);
    },
    PGLITE_TIMEOUT,
  );
});
