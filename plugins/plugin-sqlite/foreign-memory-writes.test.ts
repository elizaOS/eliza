/** Repro: memory writes must not rewrite or delete another agent's rows. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const id = () => randomUUID() as UUID;
const agentId = id();
const roomId = id();
const entityId = id();
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];

async function open(owner = agentId) {
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    owner,
  );
  opened.push(adapter);
  await adapter.initialize();
  return adapter;
}

async function seedForeign(adapter: SQLiteDatabaseAdapter) {
  const storage = await adapter.getConnection();
  const foreignId = id();
  const otherAgentId = id();
  await storage.set("memories", foreignId, {
    id: foreignId,
    agentId: otherAgentId,
    entityId,
    roomId,
    tableName: "messages",
    content: { text: "foreign message" },
    createdAt: Date.now(),
  });
  return { storage, foreignId };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-foreign-write-"));
});

afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

describe("foreign-agent memory writes", () => {
  it("updateMemories leaves another agent's row untouched", async () => {
    const adapter = await open();
    const { storage, foreignId } = await seedForeign(adapter);
    await adapter.updateMemories([
      { id: foreignId, content: { text: "hijacked" } },
    ]);
    const row = await storage.get("memories", foreignId);
    expect(row?.content?.text).toBe("foreign message");
  });

  it("upsertMemories without agentId leaves another agent's row untouched", async () => {
    const adapter = await open();
    const { storage, foreignId } = await seedForeign(adapter);
    const memory = {
      id: foreignId,
      entityId,
      roomId,
      content: { text: "hijacked" },
      createdAt: Date.now(),
    } as Memory;
    await adapter.upsertMemories([{ memory, tableName: "messages" }]);
    const row = await storage.get("memories", foreignId);
    expect(row?.content?.text).toBe("foreign message");
  });

  it("deleteMemories leaves another agent's row untouched", async () => {
    const adapter = await open();
    const { storage, foreignId } = await seedForeign(adapter);
    await adapter.deleteMemories([foreignId]);
    const row = await storage.get("memories", foreignId);
    expect(row?.content?.text).toBe("foreign message");
  });
});
