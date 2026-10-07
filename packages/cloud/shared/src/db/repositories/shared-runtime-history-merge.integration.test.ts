/**
 * Drives concurrent shared-runtime history merges against real in-process
 * PGlite so the row lock and JSONB update are exercised without mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { sharedRuntimeHistory } from "../schemas/shared-runtime-history";
import { sharedRuntimeHistoryRepository } from "./shared-runtime-history";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[shared-runtime-history-merge.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema({ sharedRuntimeHistory } as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[shared-runtime-history-merge.integration.test] PGlite schema setup failed.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(sharedRuntimeHistory);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("SharedRuntimeHistoryRepository.merge", () => {
  test("concurrent first writes preserve both turns", async () => {
    await Promise.all([
      sharedRuntimeHistoryRepository.merge("agent-1", "channel-1", [
        { id: "user-1", role: "user", content: "first", createdAt: 1 },
        {
          id: "assistant-1",
          role: "assistant",
          content: "first reply",
          createdAt: 2,
        },
      ]),
      sharedRuntimeHistoryRepository.merge("agent-1", "channel-1", [
        { id: "user-2", role: "user", content: "second", createdAt: 3 },
        {
          id: "assistant-2",
          role: "assistant",
          content: "second reply",
          createdAt: 4,
        },
      ]),
    ]);

    const stored = await sharedRuntimeHistoryRepository.get("agent-1", "channel-1");
    expect(stored.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
  });

  test("a stale direct-writer snapshot cannot erase a mirrored turn", async () => {
    await sharedRuntimeHistoryRepository.merge("agent-1", "channel-1", [
      { id: "do-user", role: "user", content: "voice", createdAt: 1 },
      {
        id: "do-assistant",
        role: "assistant",
        content: "partial",
        createdAt: 2,
        interrupted: true,
      },
    ]);

    await sharedRuntimeHistoryRepository.merge("agent-1", "channel-1", [
      { id: "external-user", role: "user", content: "gateway", createdAt: 3 },
      {
        id: "external-assistant",
        role: "assistant",
        content: "gateway reply",
        createdAt: 4,
      },
    ]);

    const stored = await sharedRuntimeHistoryRepository.get("agent-1", "channel-1");
    expect(stored.map((message) => message.id)).toEqual([
      "do-user",
      "do-assistant",
      "external-user",
      "external-assistant",
    ]);
  });
});

describe("SharedRuntimeHistoryRepository.listRecentlyActivePersonalRooms", () => {
  test("personal keepwarm eligibility precedes the room cap and is independent of the agent hot set", async () => {
    const now = Date.now();
    const personal = "personal:1b4e28ba-2fa1-51d2-883f-0016d3cca427";
    await dbWrite.insert(sharedRuntimeHistory).values([
      ...Array.from({ length: 50 }, (_, index) => ({
        agent_id: `sandbox-${index}`,
        channel_id: `sandbox-room-${index}`,
        messages: [],
        updated_at: new Date(now),
      })),
      {
        agent_id: "personal:not-an-owner",
        channel_id: "malformed",
        messages: [],
        updated_at: new Date(now),
      },
      ...Array.from({ length: 51 }, (_, index) => ({
        agent_id: personal,
        channel_id: `room-${String(index).padStart(2, "0")}`,
        messages: [],
        updated_at: new Date(now - 1000),
      })),
      { agent_id: personal, channel_id: "stale", messages: [], updated_at: new Date(now - 60000) },
    ]);
    const since = new Date(now - 10000);
    expect(
      await sharedRuntimeHistoryRepository.listRecentlyActiveAgentIds(since, 50),
    ).not.toContain(personal);
    expect(await sharedRuntimeHistoryRepository.listRecentlyActivePersonalRooms(since, 50)).toEqual(
      Array.from({ length: 50 }, (_, index) => ({
        agentId: personal,
        channelId: `room-${String(index).padStart(2, "0")}`,
      })),
    );
  });

  test("returns recent (agent, channel) rooms newest first, capped, excluding stale rooms", async () => {
    const personal = "personal:1b4e28ba-2fa1-51d2-883f-0016d3cca427";
    await sharedRuntimeHistoryRepository.merge(personal, "room-a", [
      { id: "a", role: "user", content: "a", createdAt: 1 },
    ]);
    await sharedRuntimeHistoryRepository.merge(personal, "room-b", [
      { id: "b", role: "user", content: "b", createdAt: 1 },
    ]);
    await sharedRuntimeHistoryRepository.merge("agent-1", "channel-1", [
      { id: "c", role: "user", content: "c", createdAt: 1 },
    ]);
    const now = Date.now();
    const age = async (channelId: string, ageMs: number) =>
      dbWrite
        .update(sharedRuntimeHistory)
        .set({ updated_at: new Date(now - ageMs) })
        .where(eq(sharedRuntimeHistory.channel_id, channelId));
    await age("room-a", 3_000);
    await age("room-b", 1_000);
    await age("channel-1", 60 * 60_000);

    const since = new Date(now - 10 * 60_000);
    expect(await sharedRuntimeHistoryRepository.listRecentlyActivePersonalRooms(since, 10)).toEqual(
      [
        { agentId: personal, channelId: "room-b" },
        { agentId: personal, channelId: "room-a" },
      ],
    );
    expect(await sharedRuntimeHistoryRepository.listRecentlyActivePersonalRooms(since, 1)).toEqual([
      { agentId: personal, channelId: "room-b" },
    ]);
  });
});
