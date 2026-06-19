import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { playbackOp, validatePlaybackControl } from "./playbackOp";

function createMessage(text = ""): Memory {
  return {
    id: "message-id" as `${string}-${string}-${string}-${string}-${string}`,
    entityId:
      "entity-id" as `${string}-${string}-${string}-${string}-${string}`,
    agentId: "agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    roomId: "room-id" as `${string}-${string}-${string}-${string}-${string}`,
    content: { text, source: "discord" },
    createdAt: Date.now(),
  } as Memory;
}

function createMusicService() {
  const guildId = "guild-id";
  const track = {
    id: "track-id",
    title: "Current Track",
    url: "https://example.com/song.mp3",
  };
  return {
    guildId,
    pause: vi.fn(async () => undefined),
    getQueues: vi.fn(() => new Map([[guildId, {}]])),
    getCurrentTrack: vi.fn((id: string) => (id === guildId ? track : null)),
    getIsPlaying: vi.fn((id: string) => id === guildId),
    getIsPaused: vi.fn(() => false),
  };
}

function createRuntime(
  musicService: ReturnType<typeof createMusicService>,
): IAgentRuntime {
  return {
    getService: vi.fn((name: string) =>
      name === "music" ? musicService : null,
    ),
    getRoom: vi.fn(async () => ({ serverId: musicService.guildId })),
  } as unknown as IAgentRuntime;
}

describe("PLAYBACK action", () => {
  it("validates schema-declared subaction the same as op", async () => {
    const musicService = createMusicService();
    const runtime = createRuntime(musicService);

    await expect(
      validatePlaybackControl(runtime, createMessage(), undefined, {
        subaction: "pause",
      }),
    ).resolves.toBe(true);
    await expect(
      validatePlaybackControl(runtime, createMessage(), undefined, {
        op: "pause",
      }),
    ).resolves.toBe(true);
  });

  it("dispatches schema-declared subaction without relying on message text", async () => {
    const musicService = createMusicService();
    const runtime = createRuntime(musicService);
    const callback = vi.fn(async () => undefined);
    const state = {
      data: { room: { serverId: musicService.guildId } },
    } as unknown as State;

    const result = await playbackOp.handler?.(
      runtime,
      createMessage(""),
      state,
      { subaction: "pause" },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      text: expect.stringContaining("Paused"),
    });
    expect(musicService.pause).toHaveBeenCalledWith(musicService.guildId);
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("Paused"),
      source: "discord",
    });
  });
});
