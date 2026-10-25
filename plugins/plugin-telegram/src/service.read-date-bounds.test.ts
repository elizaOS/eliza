/**
 * MESSAGE read_channel and search pass ISO before/after bounds. The Telegram
 * bot connector reads stored messages, so the bounds must reach the memory
 * query. Real TelegramService read path over a real SQLite memory store.
 */
import {
  createUniqueUuid,
  type MessageConnectorQueryContext,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { TelegramService } from "./service";

const GROUP = "-1001234567890";

async function harness() {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Telegram bounds", bio: "Test" },
    logLevel: "fatal",
  });
  await runtime.adapter.init();
  const roomId = createUniqueUuid(runtime, GROUP) as UUID;
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
        content: { text, source: "telegram" },
      },
      "messages",
    );
  }
  const service = Object.create(TelegramService.prototype) as TelegramService;
  Object.assign(service, {
    runtime,
    defaultAccountId: "default",
    accountStates: new Map(),
    knownChats: new Map([
      [GROUP, { id: Number(GROUP), type: "supergroup", title: "Team" }],
    ]),
  });
  const context = { runtime } as unknown as MessageConnectorQueryContext;
  return { service, context };
}

const target = { source: "telegram", channelId: GROUP };

it("reads only messages inside the before/after window", async () => {
  const { service, context } = await harness();
  const read = await service.fetchConnectorMessages(context, {
    target,
    after: "2026-10-19T12:00:00Z",
    before: "2026-10-21T00:00:00Z",
  });
  expect(read.map((m) => m.content.text)).toEqual(["tuesday invoice"]);
});

it("searches only messages before the before bound", async () => {
  const { service, context } = await harness();
  const found = await service.searchConnectorMessages(context, {
    target,
    query: "day",
    before: "2026-10-20T00:00:00Z",
  });
  expect(found.map((m) => m.content.text)).toEqual(["monday standup"]);
});

it("rejects a bound that is not a timestamp", async () => {
  const { service, context } = await harness();
  await expect(
    service.fetchConnectorMessages(context, { target, before: "soon" }),
  ).rejects.toThrow("Provide an ISO timestamp for Telegram history bounds.");
});
