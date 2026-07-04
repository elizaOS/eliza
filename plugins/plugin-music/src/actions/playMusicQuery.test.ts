/**
 * Smart music-query validation tests for routing-context behavior.
 *
 * They prove structured queries and media context work across languages without
 * English keyword extraction.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { validatePlayMusicQuery } from "./playMusicQuery";

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
    getSetting: vi.fn(() => undefined),
    ...overrides,
  } as unknown as IAgentRuntime;
}

function mediaContext(): State {
  return { values: { selectedContexts: ["media"] } } as unknown as State;
}

describe("PLAY_MUSIC_QUERY validate", () => {
  it("only serves the discord playback surface", async () => {
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("play some jazz", "test"),
        mediaContext(),
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("validates an English music request routed to a media context", async () => {
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("play some upbeat workout music"),
        mediaContext(),
        undefined,
      ),
    ).resolves.toBe(true);
  });

  it("validates a non-English music request identically (no English-keyword dependency)", async () => {
    // Spanish: "play something to work out to". The old English keyword bank
    // returned false here and misrouted the turn; routing-context selection
    // makes it language-agnostic.
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("pon algo de música para entrenar"),
        mediaContext(),
        undefined,
      ),
    ).resolves.toBe(true);

    // Japanese: "play the latest song".
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("最新の曲を再生して"),
        mediaContext(),
        undefined,
      ),
    ).resolves.toBe(true);
  });

  it("validates a structured query independent of message language or context", async () => {
    await expect(
      validatePlayMusicQuery(runtime(), message("再生して"), undefined, {
        parameters: { query: "Daft Punk discovery" },
      }),
    ).resolves.toBe(true);

    await expect(
      validatePlayMusicQuery(runtime(), message(""), undefined, {
        genre: "shoegaze",
      }),
    ).resolves.toBe(true);
  });

  it("does not validate without a structured query or an active music context", async () => {
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("play some upbeat workout music"),
        undefined,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("defers a direct YouTube URL to the faster playback path", async () => {
    await expect(
      validatePlayMusicQuery(
        runtime(),
        message("https://youtu.be/dQw4w9WgXcQ"),
        mediaContext(),
        undefined,
      ),
    ).resolves.toBe(false);

    await expect(
      validatePlayMusicQuery(runtime(), message("再生して"), mediaContext(), {
        query: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).resolves.toBe(false);
  });
});
