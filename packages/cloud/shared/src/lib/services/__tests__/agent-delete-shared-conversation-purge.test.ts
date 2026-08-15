/**
 * Agent deletion purges shared-runtime conversation Durable Objects (#17006).
 *
 * Drives the real `ElizaSandboxService.deleteAgent` against in-process PGlite
 * with the real repositories; only the Worker Durable Object namespace is a
 * recording fake injected through the cloud-bindings ALS store (exactly how a
 * Worker request supplies it). Pins three contracts: the purge dispatches one
 * `{operation:"delete"}` envelope per persisted channel using the turn naming
 * `${agentId}:${channelId}`, a purge failure never fails the admitted
 * deletion, and a missing binding (non-Worker runtime) skips the purge while
 * the deletion still succeeds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { organizations } from "../../../db/schemas/organizations";
import { sharedRuntimeHistory } from "../../../db/schemas/shared-runtime-history";
import { users } from "../../../db/schemas/users";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import { PROVISIONING_JOB_TEST_TABLES } from "./tier-upgrade-pglite-schema";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.error("[agent-delete-shared-conversation-purge] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(ddl);
    }
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS "shared_runtime_history" (
      "agent_id" text NOT NULL,
      "channel_id" text NOT NULL,
      "messages" jsonb NOT NULL,
      "updated_at" timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY ("agent_id", "channel_id")
    )`);
  } catch (error) {
    pgliteReady = false;
    console.error("[agent-delete-shared-conversation-purge] PGlite unavailable.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

/** A shared-tier agent (no container) with persisted history in two rooms. */
async function seedSharedAgentWithHistory(): Promise<{
  service: InstanceType<typeof ElizaSandboxService>;
  agentId: string;
  orgId: string;
  channelIds: string[];
}> {
  const service = new ElizaSandboxService();
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const created = await service.createAgent({
    organizationId: org.id,
    userId: user.id,
    agentName: uniq("agent"),
    executionTier: "shared",
    maxNonTerminalAgents: 10,
  });
  const channelIds = [uniq("room"), uniq("room")];
  for (const channelId of channelIds) {
    await dbWrite.insert(sharedRuntimeHistory).values({
      agent_id: created.agent.id,
      channel_id: channelId,
      messages: [{ role: "user", content: "hello" }],
    });
  }
  return { service, agentId: created.agent.id, orgId: org.id, channelIds };
}

function recordingNamespace(behavior: (name: string) => Promise<Response>) {
  const names: string[] = [];
  const envelopes: unknown[] = [];
  return {
    names,
    envelopes,
    namespace: {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            envelopes.push(JSON.parse(String(init?.body)));
            return await behavior(name);
          },
        };
      },
    },
  };
}

async function agentRowExists(agentId: string): Promise<boolean> {
  const rows = await dbWrite
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return rows.length > 0;
}

async function historyRowCount(agentId: string): Promise<number> {
  const rows = await dbWrite
    .select({ channel: sharedRuntimeHistory.channel_id })
    .from(sharedRuntimeHistory)
    .where(eq(sharedRuntimeHistory.agent_id, agentId));
  return rows.length;
}

describe("deleteAgent purges shared-runtime conversation objects", () => {
  test(
    "dispatches one delete envelope per persisted channel",
    async () => {
      expect(pgliteReady).toBe(true);
      const { service, agentId, orgId, channelIds } = await seedSharedAgentWithHistory();
      const fake = recordingNamespace(async () => Response.json({ success: true }));

      const result = await runWithCloudBindingsAsync(
        { SHARED_RUNTIME_CONVERSATIONS: fake.namespace },
        async () => await service.deleteAgent(agentId, orgId, { authorization: "user_request" }),
      );

      expect(result.success).toBe(true);
      expect(await agentRowExists(agentId)).toBe(false);
      expect(await historyRowCount(agentId)).toBe(0);
      expect(fake.names.sort()).toEqual(
        channelIds.map((channelId) => `${agentId}:${channelId}`).sort(),
      );
      expect(fake.envelopes).toEqual([
        { operation: "delete", agentId },
        { operation: "delete", agentId },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "purge failures never fail the admitted deletion",
    async () => {
      expect(pgliteReady).toBe(true);
      const { service, agentId, orgId, channelIds } = await seedSharedAgentWithHistory();
      const fake = recordingNamespace(async () => {
        throw new Error("durable object unreachable");
      });

      const result = await runWithCloudBindingsAsync(
        { SHARED_RUNTIME_CONVERSATIONS: fake.namespace },
        async () => await service.deleteAgent(agentId, orgId, { authorization: "user_request" }),
      );

      expect(result.success).toBe(true);
      expect(await agentRowExists(agentId)).toBe(false);
      // Every room was still attempted despite each one failing.
      expect(fake.names.length).toBe(channelIds.length);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "missing Worker binding skips the purge and still deletes",
    async () => {
      expect(pgliteReady).toBe(true);
      const { service, agentId, orgId } = await seedSharedAgentWithHistory();

      const result = await service.deleteAgent(agentId, orgId, {
        authorization: "user_request",
      });

      expect(result.success).toBe(true);
      expect(await agentRowExists(agentId)).toBe(false);
      expect(await historyRowCount(agentId)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});
