/**
 * MESSAGE read_channel and search pass ISO before/after bounds. The Google
 * Chat connector reads stored messages, so the bounds must reach the memory
 * query. Real registered connector hooks over a real SQLite memory store.
 */
import {
  createUniqueUuid,
  type Memory,
  type MessageConnectorQueryContext,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { GoogleChatService } from "./service";

type ReadHook = (
  context: MessageConnectorQueryContext,
  params: Record<string, unknown>
) => Promise<Memory[]>;

async function harness() {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Google Chat bounds", bio: "Test" },
    logLevel: "fatal",
  });
  await runtime.adapter.init();
  const roomId = createUniqueUuid(runtime, "spaces/AAA") as UUID;
  for (const [text, iso] of [
    ["monday standup", "2026-10-19T09:00:00Z"],
    ["tuesday invoice", "2026-10-20T09:00:00Z"],
    ["wednesday demo", "2026-10-21T09:00:00Z"],
  ] as const) {
    await runtime.createMemory(
      {
        id: createUniqueUuid(runtime, text) as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId,
        createdAt: Date.parse(iso),
        content: { text, source: "google-chat" },
      },
      "messages"
    );
  }
  let hooks: { fetchMessages: ReadHook; searchMessages: ReadHook } | undefined;
  Object.assign(runtime, {
    registerMessageConnector: (registration: typeof hooks) => {
      hooks = registration;
    },
  });
  GoogleChatService.registerSendHandlers(runtime, {} as GoogleChatService, "default");
  if (!hooks) throw new Error("connector was not registered");
  const context = { runtime } as unknown as MessageConnectorQueryContext;
  const target = { source: "google-chat", roomId };
  return { hooks, context, target };
}

const texts = (memories: Memory[]) => memories.map((m) => m.content.text);

it("reads only messages inside the before/after window", async () => {
  const { hooks, context, target } = await harness();
  const read = await hooks.fetchMessages(context, {
    target,
    after: "2026-10-19T12:00:00Z",
    before: "2026-10-21T00:00:00Z",
  });
  expect(texts(read)).toEqual(["tuesday invoice"]);
});

it("searches only messages after the after bound", async () => {
  const { hooks, context, target } = await harness();
  const found = await hooks.searchMessages(context, {
    target,
    query: "day",
    after: "2026-10-21T00:00:00Z",
  });
  expect(texts(found)).toEqual(["wednesday demo"]);
});
