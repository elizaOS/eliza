/**
 * Real-DB proof for the `deletion_started_at` write on the delete re-enqueue
 * path (#17249).
 *
 * A retry of a failed deletion must keep the ORIGINAL start time — that is the
 * whole point of the column, it measures how long the agent has been stuck
 * deleting rather than how long the current attempt has run. The re-enqueue
 * used to preserve it by reading the stored value off the row and writing it
 * straight back, which changed nothing in the row while making the write depend
 * on the read having produced a `Date`. In production every one of the 37
 * `deletion_failed` agents had both `deletion_started_at` and
 * `deletion_attempt_id` set, so every retry took exactly that branch.
 *
 * The column is now simply left untouched when continuing a deletion, so these
 * tests pin the observable contract that made the read-back look necessary:
 *   - a FRESH deletion stamps a start time,
 *   - a CONTINUED deletion preserves the original one, to the millisecond.
 *
 * Drives the REAL ProvisioningJobService.enqueueAgentDeleteOnce against
 * in-process PGlite (real Drizzle schema via pushSchema) with NOTHING mocked.
 * Fails LOUDLY if PGlite/pushSchema is unavailable (never silently passes).
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
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { generations } from "../../../db/schemas/generations";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
/** Far enough back that a re-stamp is unmistakable, not a clock-skew artifact. */
const ORIGINAL_START = new Date("2026-07-13T04:11:00.000Z");

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let ProvisioningJobService: typeof import("../provisioning-jobs").ProvisioningJobService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedAgent(): Promise<{ agentId: string; orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const res = await new ElizaSandboxService().createAgent({
    organizationId: org.id,
    userId: user.id,
    agentName: uniq("agent"),
    executionTier: "dedicated-always",
    maxNonTerminalAgents: 10,
  });
  return { agentId: res.agent.id, orgId: org.id, userId: user.id };
}

/**
 * Put the row in the state every stranded production agent was in: a deletion
 * that already started, already has an attempt id, and already failed.
 */
async function markDeletionAlreadyStarted(agentId: string): Promise<void> {
  await dbWrite
    .update(agentSandboxes)
    .set({
      status: "deletion_failed",
      deletion_started_at: ORIGINAL_START,
      deletion_attempt_id: crypto.randomUUID(),
      error_message: "Deletion permanently failed after 3 attempts: SSH connect timed out",
      updated_at: new Date(),
    })
    .where(eq(agentSandboxes.id, agentId));
}

async function readDeletionStartedAt(agentId: string): Promise<Date | null> {
  const row = await dbWrite.query.agentSandboxes.findFirst({
    where: eq(agentSandboxes.id, agentId),
  });
  return row?.deletion_started_at ?? null;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[deletion-started-at-preservation.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
    ({ ProvisioningJobService } = await import("../provisioning-jobs"));

    // apiKeys -> generations -> usageRecords is the FK chain agentSandboxes
    // pulls in; jobs is needed for the enqueue path.
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      generations,
      usageRecords,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[deletion-started-at-preservation.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("deletion_started_at is stamped once and never re-written", () => {
  test("PGlite harness came up", () => {
    expect(pgliteReady).toBe(true);
  });



  test(
    "enqueueAgentDeleteOnce preserves the original start time when re-enqueueing a failed deletion",
    async () => {
      const { agentId, orgId, userId } = await seedAgent();
      await markDeletionAlreadyStarted(agentId);

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });

      expect(await readDeletionStartedAt(agentId)).toEqual(ORIGINAL_START);
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: eq(agentSandboxes.id, agentId),
      });
      // The re-enqueue still has to arm the retry, otherwise "preserved" would
      // be trivially true because nothing ran.
      expect(row?.status).toBe("deletion_pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "enqueueAgentDeleteOnce stamps a start time on a FRESH deletion",
    async () => {
      const { agentId, orgId, userId } = await seedAgent();
      expect(await readDeletionStartedAt(agentId)).toBeNull();

      const before = Date.now();
      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });
      const after = Date.now();

      const stamped = await readDeletionStartedAt(agentId);
      expect(stamped).toBeInstanceOf(Date);
      expect(stamped!.getTime()).toBeGreaterThanOrEqual(before);
      expect(stamped!.getTime()).toBeLessThanOrEqual(after);
    },
    PGLITE_TIMEOUT,
  );
});
