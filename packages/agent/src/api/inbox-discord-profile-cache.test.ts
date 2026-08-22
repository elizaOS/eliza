/**
 * Retention coverage for the Discord profile caches in inbox-routes.
 *
 * All three caches stamp entries with a TTL but only ever evict a key when that
 * exact key is read back after it expired (`readCachedValue`).
 * `discordMessageAuthorProfileCache` is keyed by `${channelId}:${messageId}`,
 * so a key is only re-read while its message is still inside the inbox window.
 * Once the message scrolls out, the entry is both unreachable and unservable
 * (its TTL has passed) yet stays resident for the life of the agent process.
 *
 * These tests drive the real `handleInboxRoute` seam — no stand-in for the
 * module under test — and assert the cache stays bounded while still serving
 * repeat reads from memory.
 */
import type http from "node:http";
import type { AgentRuntime, Memory, RouteHelpers, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleInboxRoute,
  MAX_DISCORD_PROFILE_CACHE_ENTRIES,
} from "./inbox-routes";

// The messages route lazily imports the connector plugin for avatar caching.
vi.mock("@elizaos/plugin-discord", () => ({
  cacheDiscordAvatarUrl: async (avatarUrl: string | undefined) => avatarUrl,
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const CHANNEL_ID = "inbox-cache-channel";
const res = {} as http.ServerResponse;

function memoryForMessage(index: number, messageId: string): Memory {
  const pad = (n: number) => String(n).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${pad(index)}` as UUID,
    entityId: `00000000-0000-4000-8000-${pad(index + 900_000)}` as UUID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1_700_000_000_000 + index,
    content: { text: `message ${messageId}`, source: "discord" },
    metadata: {
      discordChannelId: CHANNEL_ID,
      discordMessageId: messageId,
    },
  } as unknown as Memory;
}

function makeInboxWorld() {
  let currentMemories: Memory[] = [];
  const messageFetches: string[] = [];
  const discordMessages = {
    fetch: async (id: string) => {
      messageFetches.push(id);
      return {
        author: { id: `author-${id}`, username: `user-${id}` },
        member: null,
      };
    },
  };
  const client = {
    channels: {
      cache: { get: () => undefined },
      fetch: async () => ({ name: "general", messages: discordMessages }),
    },
    // No users.fetch: keeps this suite on the message-author cache only.
    users: {},
  };
  const runtime = {
    agentId: AGENT_ID,
    getRoom: async () => ({
      id: ROOM_ID,
      name: "general",
      source: "discord",
      channelId: CHANNEL_ID,
    }),
    getMemories: async () => currentMemories,
    getEntityById: async () => null,
    getService: (name: string) => (name === "discord" ? { client } : null),
    fetch,
  } as unknown as AgentRuntime;

  return {
    runtime,
    messageFetches,
    setMemories(memories: Memory[]) {
      currentMemories = memories;
    },
  };
}

async function requestInbox(runtime: AgentRuntime, limit: number) {
  const json = vi.fn();
  const error = vi.fn();
  const helpers = {
    json,
    error,
    readJsonBody: vi.fn(),
  } as unknown as RouteHelpers;
  const handled = await handleInboxRoute(
    {
      url: `/api/inbox/messages?roomId=${ROOM_ID}&sources=discord&limit=${limit}`,
    } as http.IncomingMessage,
    res,
    "/api/inbox/messages",
    "GET",
    { runtime },
    helpers,
  );
  expect(handled).toBe(true);
  expect(error).not.toHaveBeenCalled();
  return json.mock.calls.at(-1)?.[1];
}

function countFetches(fetches: readonly string[], messageId: string): number {
  return fetches.filter((id) => id === messageId).length;
}

describe("inbox Discord message-author cache", () => {
  it("still serves a repeat read of a live message from cache", async () => {
    const world = makeInboxWorld();
    world.setMemories([memoryForMessage(0, "cache-hit-probe")]);

    const first = await requestInbox(world.runtime, 100);
    const second = await requestInbox(world.runtime, 100);

    expect(countFetches(world.messageFetches, "cache-hit-probe")).toBe(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not retain entries past the cache bound", async () => {
    const world = makeInboxWorld();
    const probeId = "retention-probe";

    world.setMemories([memoryForMessage(0, probeId)]);
    await requestInbox(world.runtime, 100);
    expect(countFetches(world.messageFetches, probeId)).toBe(1);

    // Push strictly more distinct message ids through the feed than the cache
    // is allowed to hold. The probe was the oldest write, so a bounded cache
    // must have dropped it by now.
    const pageSize = 500;
    let index = 1;
    for (
      let pushed = 0;
      pushed <= MAX_DISCORD_PROFILE_CACHE_ENTRIES;
      pushed += pageSize
    ) {
      const page: Memory[] = [];
      for (let i = 0; i < pageSize; i += 1) {
        page.push(memoryForMessage(index, `filler-${index}`));
        index += 1;
      }
      world.setMemories(page);
      await requestInbox(world.runtime, pageSize);
    }

    world.setMemories([memoryForMessage(0, probeId)]);
    await requestInbox(world.runtime, 100);

    expect(countFetches(world.messageFetches, probeId)).toBe(2);
  });
});
