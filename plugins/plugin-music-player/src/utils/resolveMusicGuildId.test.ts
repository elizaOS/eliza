import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveMusicGuildIdForPlayback } from "./resolveMusicGuildId.js";

function mockMusicService(tracks: Record<string, { title: string } | null>): {
  getCurrentTrack: (guildId: string) => { title: string } | null;
  getQueues: () => Map<string, unknown>;
} {
  return {
    getCurrentTrack: (guildId: string) => tracks[guildId] ?? null,
    getQueues: () => new Map(Object.keys(tracks).map((k) => [k, {}])),
  };
}

describe("resolveMusicGuildIdForPlayback", () => {
  it("uses web-${roomId} when room has no serverId (web chat)", () => {
    const roomId = "room-uuid-1";
    const message = {
      roomId,
      content: { source: "client_chat" },
    } as Memory;
    const guild = `web-${roomId}`;
    const svc = mockMusicService({ [guild]: { title: "Song" } });
    expect(resolveMusicGuildIdForPlayback(message, {}, svc as never)).toBe(
      guild,
    );
  });

  it("prefixes web- onto room.serverId for non-Discord", () => {
    const message = {
      roomId: "room-uuid-2",
      content: { source: "client_chat" },
    } as Memory;
    const svc = mockMusicService({ "web-abc": { title: "Song" } });
    expect(
      resolveMusicGuildIdForPlayback(
        message,
        { serverId: "abc" },
        svc as never,
      ),
    ).toBe("web-abc");
  });

  it("does not use raw serverId as guild key (would miss web- queue)", () => {
    const message = {
      roomId: "room-uuid-3",
      content: { source: "client_chat" },
    } as Memory;
    const svc = mockMusicService({
      abc: null,
      "web-abc": { title: "Song" },
    });
    expect(
      resolveMusicGuildIdForPlayback(
        message,
        { serverId: "abc" },
        svc as never,
      ),
    ).toBe("web-abc");
  });

  it("falls back to first active guild when resolved id has no track", () => {
    const message = {
      roomId: "x",
      content: { source: "client_chat" },
    } as Memory;
    const svc = mockMusicService({
      "web-x": null,
      "web-other": { title: "Other" },
    });
    expect(resolveMusicGuildIdForPlayback(message, {}, svc as never)).toBe(
      "web-other",
    );
  });

  it("uses Discord serverId without web- prefix", () => {
    const message = {
      roomId: "r",
      content: { source: "discord" },
    } as Memory;
    const svc = mockMusicService({
      "123456789": { title: "Song" },
    });
    expect(
      resolveMusicGuildIdForPlayback(
        message,
        { serverId: "123456789" },
        svc as never,
      ),
    ).toBe("123456789");
  });
});
