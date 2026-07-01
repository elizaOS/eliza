import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handlePlayMusicQuery, validatePlayMusicQuery } from "./playMusicQuery";

function message(text = "", source = "discord"): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source },
    createdAt: Date.now(),
  } as Memory;
}

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    getCache: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setCache: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("PLAY_MUSIC_QUERY action", () => {
  it("does not validate English prose without a structured query", async () => {
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("play some 80s synth pop"),
        undefined,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("validates structured query parameters independent of message language", async () => {
    await expect(
      validatePlayMusicQuery(runtime(), message("音楽を再生して"), undefined, {
        parameters: { query: "80s synth pop" },
      }),
    ).resolves.toBe(true);
  });

  it("leaves direct YouTube URLs to the YouTube/audio actions", async () => {
    await expect(
      validatePlayMusicQuery(runtime(), message("再生して"), undefined, {
        parameters: { query: "https://youtu.be/example" },
      }),
    ).resolves.toBe(false);
  });

  it("asks for a structured query instead of using message text", async () => {
    const callback = vi.fn(async () => undefined);

    const result = await handlePlayMusicQuery(
      runtime(),
      message("play the strokes first single"),
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Missing music query",
    });
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("query parameter"),
      source: "discord",
    });
  });

  it("uses the structured query in the confirmation preview", async () => {
    const callback = vi.fn(async () => undefined);

    const result = await handlePlayMusicQuery(
      runtime(),
      message("ignore this raw prose"),
      undefined,
      { parameters: { searchQuery: "The Strokes first single" } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      data: { requiresConfirmation: true },
    });
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("The Strokes first single"),
      source: "discord",
    });
    expect(callback).not.toHaveBeenCalledWith({
      text: expect.stringContaining("ignore this raw prose"),
      source: "discord",
    });
  });
});
