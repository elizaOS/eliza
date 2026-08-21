/**
 * Unit coverage for session-bridge — Eliza session-key resolution from
 * elizaOS rooms (DM/group/channel/thread) and the provider wrapper.
 */
import { describe, expect, it, vi } from "vitest";

// Mock @elizaos/core primitives used by session-bridge
vi.mock("@elizaos/core", () => {
  const ChannelType = {
    DM: "dm",
    SELF: "self",
    GROUP: "group",
    FEED: "feed",
  };
  return {
    ChannelType,
    buildAgentMainSessionKey: ({ agentId }: { agentId: string }) =>
      `agent:${agentId}:main`,
    parseAgentSessionKey: (key: string) => {
      // agent:{agentId}:main
      const m = /^agent:([^:]+):main$/.exec(key);
      return m ? { agentId: m[1] } : null;
    },
  };
});

import { ChannelType } from "@elizaos/core";
import {
  createSessionKeyProvider,
  resolveSessionKeyFromRoom,
} from "./session-bridge.ts";

function makeRoom(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "room-1",
    type: ChannelType.DM,
    source: "telegram",
    channelId: "chan-1",
    ...overrides,
  } as never;
}

describe("resolveSessionKeyFromRoom", () => {
  it("maps DM to agent:{agentId}:main", () => {
    expect(resolveSessionKeyFromRoom("agent-1", makeRoom())).toBe(
      "agent:agent-1:main",
    );
  });

  it("maps SELF to main", () => {
    expect(
      resolveSessionKeyFromRoom("a", makeRoom({ type: ChannelType.SELF })),
    ).toBe("agent:a:main");
  });

  it("maps a group room to agent:{id}:{channel}:group:{groupId}", () => {
    const room = makeRoom({
      type: ChannelType.GROUP,
      source: "telegram",
      channelId: "g-9",
    });
    expect(resolveSessionKeyFromRoom("a1", room)).toBe(
      "agent:a1:telegram:group:g-9",
    );
  });

  it("prefers meta.groupId over room.channelId for groups", () => {
    const room = makeRoom({
      type: ChannelType.GROUP,
      source: "discord",
      channelId: "chan-fallback",
    });
    expect(
      resolveSessionKeyFromRoom("a1", room, { groupId: "real-group" }),
    ).toBe("agent:a1:discord:group:real-group");
  });

  it("maps a feed room to agent:{id}:{channel}:channel:{channelId}", () => {
    const room = makeRoom({
      type: ChannelType.FEED,
      source: "slack",
      channelId: "c-42",
    });
    expect(resolveSessionKeyFromRoom("a1", room)).toBe(
      "agent:a1:slack:channel:c-42",
    );
  });

  it("appends :thread:{threadId} when provided", () => {
    const room = makeRoom({
      type: ChannelType.GROUP,
      source: "telegram",
      channelId: "g-1",
    });
    expect(resolveSessionKeyFromRoom("a1", room, { threadId: "t-7" })).toBe(
      "agent:a1:telegram:group:g-1:thread:t-7",
    );
  });

  it("uses meta.channel over room.source", () => {
    const room = makeRoom({
      type: ChannelType.GROUP,
      source: "telegram",
      channelId: "g-1",
    });
    expect(resolveSessionKeyFromRoom("a1", room, { channel: "whatsapp" })).toBe(
      "agent:a1:whatsapp:group:g-1",
    );
  });

  it("falls back to room.id when channelId is absent", () => {
    const room = makeRoom({
      type: ChannelType.GROUP,
      source: "web",
      channelId: undefined,
      id: "room-fallback",
    });
    expect(resolveSessionKeyFromRoom("a1", room)).toBe(
      "agent:a1:web:group:room-fallback",
    );
  });
});

describe("createSessionKeyProvider", () => {
  it("reuses an existing session key from metadata", async () => {
    const provider = createSessionKeyProvider();
    const result = await provider.get(
      {} as never,
      { metadata: { sessionKey: "agent:a1:main" } } as never,
      {} as never,
    );
    expect(result.values?.sessionKey).toBe("agent:a1:main");
    expect(result.values?.agentId).toBe("a1");
  });

  it("falls back to main key when the room is missing", async () => {
    const provider = createSessionKeyProvider({ defaultAgentId: "dflt" });
    const runtime = { getRoom: vi.fn(async () => null) };
    const result = await provider.get(
      runtime as never,
      { metadata: {}, roomId: "r" } as never,
      {} as never,
    );
    expect(result.values?.sessionKey).toBe("agent:dflt:main");
  });

  it("resolves room-derived keys and flags groups", async () => {
    const provider = createSessionKeyProvider({ defaultAgentId: "a1" });
    const runtime = {
      getRoom: vi.fn(async () =>
        makeRoom({
          type: ChannelType.GROUP,
          source: "telegram",
          channelId: "g-5",
        }),
      ),
    };
    const result = await provider.get(
      runtime as never,
      { metadata: {}, roomId: "r1" } as never,
      {} as never,
    );
    expect(result.values?.sessionKey).toBe("agent:a1:telegram:group:g-5");
    expect(result.values?.isGroup).toBe(true);
  });
});
