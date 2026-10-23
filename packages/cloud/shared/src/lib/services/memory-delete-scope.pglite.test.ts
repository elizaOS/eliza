/** Real room-ownership SQL on PGlite (users + participants tables).
 * The system runtime is an in-memory memory store; no provider/network calls.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import * as realFactory from "@elizaos/cloud-shared/lib/eliza/runtime-factory";
import type { Memory, UUID } from "@elizaos/core";
import { participantTable } from "@elizaos/plugin-sql";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const ROOM_A = "55555555-5555-4555-8555-555555555555" as UUID;
const ROOM_B = "66666666-6666-4666-8666-666666666666" as UUID;
const MEMORY_A = "77777777-7777-4777-8777-777777777777" as UUID;
const MEMORY_B = "88888888-8888-4888-8888-888888888888" as UUID;

const pg = new PGlite();
const database = drizzle(pg);
const stored = new Map<UUID, Memory>();
const runtime = {
  agentId: "99999999-9999-4999-8999-999999999999" as UUID,
  getMemoryById: async (id: UUID) => stored.get(id) ?? null,
  deleteMemory: async (id: UUID) => {
    stored.delete(id);
  },
};
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...realDb,
  dbRead: database,
  dbWrite: database,
}));
mock.module("@elizaos/cloud-shared/lib/eliza/runtime-factory", () => ({
  ...realFactory,
  runtimeFactory: { createRuntimeForUser: async () => runtime },
}));
const { executeSkillDeleteMemory } = await import("../api/a2a/skills");

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

beforeAll(async () => {
  for (const table of [users, participantTable]) {
    const config = getTableConfig(table);
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns.map((c) => `${quote(c.name)} ${c.getSQLType()}`).join(",")})`,
    );
  }
  await pg.exec(`INSERT INTO users (id, organization_id) VALUES
    ('${USER_A}', '${ORG_A}'), ('${USER_B}', '${ORG_B}')`);
  await pg.exec(`INSERT INTO participants (id, entity_id, room_id, agent_id) VALUES
    (gen_random_uuid(), '${USER_A}', '${ROOM_A}', '${runtime.agentId}'),
    (gen_random_uuid(), '${USER_B}', '${ROOM_B}', '${runtime.agentId}')`);
  for (const [id, roomId, entityId] of [
    [MEMORY_A, ROOM_A, USER_A],
    [MEMORY_B, ROOM_B, USER_B],
  ] as const) {
    stored.set(id, {
      id,
      roomId,
      entityId: entityId as UUID,
      agentId: runtime.agentId,
      content: { text: "note" },
    });
  }
});
afterAll(async () => {
  await pg.close();
});

const ctxFor = (organizationId: string, userId: string) =>
  ({ user: { id: userId, organization_id: organizationId } }) as Parameters<
    typeof executeSkillDeleteMemory
  >[1];

test("delete_memory refuses a memory in another organization's room and keeps it", async () => {
  await expect(
    executeSkillDeleteMemory({ memoryId: MEMORY_B }, ctxFor(ORG_A, USER_A)),
  ).rejects.toThrow("Memory not found");
  expect(stored.has(MEMORY_B)).toBe(true);
});

test("delete_memory reports a missing memory instead of success", async () => {
  await expect(
    executeSkillDeleteMemory(
      { memoryId: "00000000-0000-4000-8000-000000000000" },
      ctxFor(ORG_A, USER_A),
    ),
  ).rejects.toThrow("Memory not found");
});

test("delete_memory deletes a memory in the caller's own room", async () => {
  await expect(
    executeSkillDeleteMemory({ memoryId: MEMORY_A }, ctxFor(ORG_A, USER_A)),
  ).resolves.toEqual({ success: true, memoryId: MEMORY_A });
  expect(stored.has(MEMORY_A)).toBe(false);
});
