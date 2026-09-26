/** Query deletion through the real host action and file-backed SQLite. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  ChannelType,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { afterEach, expect, it } from "vitest";
import { memoryAction } from "../src/actions/memories.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([false, true])(
  "preserves distinct claims before an explicit by-id deletion (same text: %s)",
  async (sameText) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "memory-delete-authority-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const runtime = new AgentRuntime({
      agentId: randomUUID() as UUID,
      character: { name: "Memory deletion acceptance", bio: [], settings: {} },
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(directory, "agent.sqlite"),
        runtime.agentId,
      ),
    );
    await runtime.init();
    cleanups.push(() => runtime.close());
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        type: ChannelType.DM,
        source: "test",
      },
    ]);
    const firstId = randomUUID() as UUID;
    const secondId = randomUUID() as UUID;
    const text = "My favorite color is blue.";
    await runtime.createMemories([
      {
        tableName: "facts",
        memory: {
          id: firstId,
          roomId,
          entityId,
          agentId: runtime.agentId,
          createdAt: 1,
          content: { text },
          metadata: { kind: "durable" },
        },
      },
      {
        tableName: "facts",
        memory: {
          id: secondId,
          roomId,
          entityId,
          agentId: runtime.agentId,
          createdAt: 2,
          content: {
            text: sameText
              ? text
              : "My favorite color for the kitchen is white.",
          },
          metadata: { kind: "current" },
        },
      },
    ]);
    const message: Memory = {
      id: randomUUID() as UUID,
      roomId,
      entityId,
      agentId: runtime.agentId,
      content: { text: "Forget my favorite color." },
    };
    const result = await memoryAction.handler(runtime, message, undefined, {
      parameters: {
        op: "delete",
        type: "facts",
        query: "favorite color",
        confirm: true,
      },
    });
    if (sameText) {
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
      expect(await runtime.getMemoryById(firstId)).toBeNull();
      expect(await runtime.getMemoryById(secondId)).toBeNull();
    } else {
      expect(result).toMatchObject({
        success: false,
        data: { error: "MEMORY_AMBIGUOUS_QUERY" },
      });
      expect(await runtime.getMemoryById(firstId)).not.toBeNull();
      expect(await runtime.getMemoryById(secondId)).not.toBeNull();
      const deleted = await memoryAction.handler(runtime, message, undefined, {
        parameters: { op: "delete", memoryId: firstId, confirm: true },
      });
      expect(deleted).toMatchObject({ success: true });
      expect(await runtime.getMemoryById(firstId)).toBeNull();
      expect(await runtime.getMemoryById(secondId)).not.toBeNull();
    }
  },
);
