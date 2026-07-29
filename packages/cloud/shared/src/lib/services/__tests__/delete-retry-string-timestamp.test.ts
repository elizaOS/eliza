/**
 * Regression proof for #17249: retrying a failed deletion crashed with
 * `value.toISOString is not a function` on EVERY attempt, trapping the agent
 * in `deletion_failed` forever (37 agents, 160/160 delete jobs in prod).
 *
 * Root cause: `getAgentForLifecycleMutation` WAS a raw `SELECT * FOR UPDATE`
 * (typed since #17262), and raw drizzle rows carry timestamptz as STRINGS
 * despite the Date type.
 * A first deletion (column NULL) wrote `new Date()` and worked; every retry
 * read the string back and pushed it through the typed update builder, which
 * throws in `mapToDriverValue`. The ownership fence's `?.getTime()` was the
 * same class of crash one step later.
 *
 * PGlite's raw rows are strings exactly like production's — this harness
 * reproduces the incident faithfully (verified against the live CP stack
 * trace), so these tests fail on the pre-fix code with the production error.
 *
 * Drives the REAL ElizaSandboxService.executeDeletion against in-process
 * PGlite (real Drizzle schema via pushSchema) with NOTHING mocked. Fails
 * LOUDLY if PGlite/pushSchema is unavailable (never silently passes).
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
const ORIGINAL_START = new Date("2026-07-13T04:11:00.000Z");

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[delete-retry-string-timestamp.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
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
      "[delete-retry-string-timestamp.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("deletion retries survive raw-row string timestamps (#17249)", () => {
  test(
    "retrying a FAILED deletion completes instead of crashing on the read-back timestamp",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      // The exact production shape of the 37 trapped agents: deletion already
      // started and failed, both intent columns set, no container left.
      const [rec] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("trapped"),
          status: "deletion_failed",
          execution_tier: "dedicated-always",
          deletion_started_at: ORIGINAL_START,
          deletion_attempt_id: crypto.randomUUID(),
          error_message: "Deletion permanently failed after 3 attempts: SSH connect timed out",
        })
        .returning();

      const result = await new ElizaSandboxService().executeDeletion(rec.id, orgId);

      // Pre-fix this crashed in prepareAgentDelete with
      // `value.toISOString is not a function` before anything ran.
      expect(result.success).toBe(true);
      const gone = await dbWrite.query.agentSandboxes.findFirst({
        where: eq(agentSandboxes.id, rec.id),
      });
      expect(gone).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a FRESH deletion still completes and clears the row",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const [rec] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("fresh"),
          status: "stopped",
          execution_tier: "dedicated-always",
        })
        .returning();

      const result = await new ElizaSandboxService().executeDeletion(rec.id, orgId);

      expect(result.success).toBe(true);
      const gone = await dbWrite.query.agentSandboxes.findFirst({
        where: eq(agentSandboxes.id, rec.id),
      });
      expect(gone).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );
});
