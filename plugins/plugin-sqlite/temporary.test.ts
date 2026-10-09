/** Exercises native and portable temporary SQLite isolation, transactions and ownership. */
import { randomUUID } from "node:crypto";
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getTrustedDeliveryAudience,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter as NativeAdapter } from "./adapter";
import { SQLiteDatabaseAdapter as PortableAdapter } from "./portable";

for (const [name, Adapter] of [
  ["native", NativeAdapter],
  ["portable", PortableAdapter],
] as const) {
  describe(`${name} temporary SQLite`, () => {
    it("isolates databases and rolls back failed transactions", async () => {
      const agentId = randomUUID() as UUID;
      const first = Adapter.create(":memory:", agentId);
      const second = Adapter.create(":memory:", agentId);
      try {
        await first.recordStore.set("plugin_fixture", "initial", {
          complete: "first operation",
        });
        expect(
          await first.recordStore.get("plugin_fixture", "initial"),
        ).toEqual({ complete: "first operation" });
        await first.setCaches([
          { key: "saved", value: { complete: "value", count: 2n } },
        ]);
        expect(
          (await second.getCaches(["saved"])).get("saved"),
        ).toBeUndefined();
        await expect(
          first.transaction(async (tx) => {
            await tx.setCaches([
              { key: "saved", value: { complete: "changed" } },
            ]);
            await tx.setCaches([{ key: "uncommitted", value: true }]);
            throw new Error("abort transaction");
          }),
        ).rejects.toMatchObject({
          code: "SQLITE_TRANSACTION_FAILED",
          cause: expect.objectContaining({ message: "abort transaction" }),
        });
        expect((await first.getCaches(["saved"])).get("saved")).toEqual({
          complete: "value",
          count: 2n,
        });
        expect(
          (await first.getCaches(["uncommitted"])).get("uncommitted"),
        ).toBeUndefined();
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });

    it("persists complete attested messages without replaying live delivery authority", async () => {
      const agentId = randomUUID() as UUID;
      const adapter = Adapter.create(":memory:", agentId);
      const runtime = new AgentRuntime({
        character: { id: agentId, name: "SQLite proof" },
        adapter,
        logLevel: "fatal",
      });
      const memory: Memory & { id: UUID } = {
        id: randomUUID() as UUID,
        agentId,
        entityId: agentId,
        roomId: randomUUID() as UUID,
        content: { text: "Complete attested message ".repeat(1000) },
      };
      try {
        await attestAuthenticatedApiDeliveryAudience(runtime, memory, {
          kind: "service_gateway",
          principalId: "fixture",
        });
        const authority = getTrustedDeliveryAudience(memory);
        expect(authority).toBeDefined();
        await adapter.createMemories([{ memory, tableName: "messages" }]);
        await adapter.upsertMemories([{ memory, tableName: "messages" }]);
        await adapter.updateMemories([{ ...memory, id: memory.id }]);
        const stored = (await adapter.getMemoriesByIds([memory.id]))[0];
        expect(stored.content).toEqual(memory.content);
        expect(getTrustedDeliveryAudience(stored)).toBeUndefined();
        expect(getTrustedDeliveryAudience(memory)).toBe(authority);
      } finally {
        await adapter.close();
      }
    });

    it("rejects foreign-agent writes and use after close", async () => {
      const adapter = Adapter.create(":memory:", randomUUID() as UUID);
      try {
        await expect(
          adapter.createEntities([
            {
              id: randomUUID() as UUID,
              agentId: randomUUID() as UUID,
              names: ["Foreign"],
            },
          ]),
        ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
      } finally {
        await adapter.close();
      }
      await expect(adapter.getCaches(["saved"])).rejects.toMatchObject({
        code: "SQLITE_NOT_READY",
      });
    });
  });
}

it("rejects persistent paths for the portable engine before filesystem access", () => {
  expect(() =>
    PortableAdapter.create("/unavailable/agent.sqlite", randomUUID() as UUID),
  ).toThrow("Portable SQLite supports only :memory:");
});

it("preserves synchronous subclass facades while keeping inherited writes transactional", async () => {
  class Facade extends NativeAdapter {
    getDataDir(): string {
      return "/fixture";
    }
  }
  const adapter = Facade.create(":memory:", randomUUID() as UUID);
  try {
    expect(adapter.getDataDir()).toBe("/fixture");
    await adapter.setCaches([{ key: "record", value: "stored" }]);
    expect((await adapter.getCaches(["record"])).get("record")).toBe("stored");
  } finally {
    await adapter.close();
  }
});
