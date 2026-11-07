/** Query deletion from an addressed message whose agent name is not ASCII. */
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
import { memoryAction } from "@elizaos/plugin-assistant";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([
  ["Eliza", "<@1490833123> Eliza forget my favorite tea", true],
  ["Eliza", "please delete my favorite tea", true],
  ["Eliza", "remove my favorite tea", true],
  ["Eliza", "could you please erase my favorite tea", true],
  ["Eliza", 'forget the memory about "delete tea"', false],
  ["Eliza", 'forget the memory about "remove tea"', false],
  ["Zoë", "<@1490833123> Zoë forget my favorite tea", true],
  ["미나", "<@1490833123> 미나 forget my favorite tea", true],
])(
  "drops the addressed agent name %s from the implied delete query",
  async (agentName, text, shouldDelete) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "memory-delete-addressed-name-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const runtime = new AgentRuntime({
      agentId: randomUUID() as UUID,
      character: { name: agentName, bio: [], settings: {} },
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
        type: ChannelType.GROUP,
        source: "discord",
      },
    ]);
    const factId = randomUUID() as UUID;
    await runtime.createMemories([
      {
        tableName: "facts",
        memory: {
          id: factId,
          roomId,
          entityId,
          agentId: runtime.agentId,
          createdAt: 1,
          content: { text: "My favorite tea is genmaicha." },
          metadata: { kind: "durable" },
        },
      },
    ]);
    const message: Memory = {
      id: randomUUID() as UUID,
      roomId,
      entityId,
      agentId: runtime.agentId,
      content: { text },
    };
    const result = await memoryAction.handler(runtime, message, undefined, {
      parameters: { op: "delete", type: "facts", confirm: true },
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      success: shouldDelete,
    });
    const retained = await runtime.getMemoryById(factId);
    if (shouldDelete) expect(retained).toBeNull();
    else expect(retained?.id).toBe(factId);
  },
);
