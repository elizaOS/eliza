/**
 * Music library provider tests for language-agnostic structured context.
 *
 * They verify the provider emits the same library payload regardless of request
 * language.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import musicLibraryProvider from "./musicLibraryProvider";

const musicLibraryMocks = vi.hoisted(() => ({
  getLibraryStats: vi.fn(),
  getMostPlayedSongs: vi.fn(),
  getRecentSongs: vi.fn(),
}));

vi.mock("../components/musicLibrary", () => musicLibraryMocks);

function messageWithText(text: string): Memory {
  return {
    content: { text },
  } as Memory;
}

describe("musicLibraryProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    musicLibraryMocks.getLibraryStats.mockResolvedValue({
      totalSongs: 2,
      totalPlays: 7,
      mostPlayed: {
        title: "Everything In Its Right Place",
        artist: "Radiohead",
        playCount: 5,
      },
    });
    musicLibraryMocks.getMostPlayedSongs.mockResolvedValue([
      {
        title: "Everything In Its Right Place",
        artist: "Radiohead",
        channel: "",
        playCount: 5,
        duration: 251,
      },
    ]);
    musicLibraryMocks.getRecentSongs.mockResolvedValue([
      {
        title: "Idioteque",
        artist: "Radiohead",
        channel: "",
        playCount: 2,
        lastPlayed: Date.now() - 60_000,
      },
    ]);
  });

  it("returns the same structured library context without English request gating", async () => {
    const runtime = {} as unknown as IAgentRuntime;

    const english = await musicLibraryProvider.get(
      runtime,
      messageWithText("what tracks do you have?"),
      {} as State,
    );
    const japanese = await musicLibraryProvider.get(
      runtime,
      messageWithText("ライブラリには何がありますか"),
      {} as State,
    );

    const englishPayload = JSON.parse(english.text);
    const japanesePayload = JSON.parse(japanese.text);

    expect(englishPayload).toHaveProperty("music_library");
    expect(japanesePayload).toHaveProperty("music_library");
    expect(englishPayload).not.toHaveProperty("recent_music");
    expect(japanesePayload).not.toHaveProperty("recent_music");
    expect(englishPayload.music_library).toMatchObject({
      total_tracks: 2,
      total_plays: 7,
      top_tracks: [
        {
          rank: 1,
          title: "Everything In Its Right Place",
          artist: "Radiohead",
          play_count: 5,
          duration: 251,
        },
      ],
      recent_tracks: [
        {
          rank: 1,
          title: "Idioteque",
          artist: "Radiohead",
          play_count: 2,
        },
      ],
    });
    expect(japanesePayload.music_library).toMatchObject(
      englishPayload.music_library,
    );
    expect(musicLibraryMocks.getMostPlayedSongs).toHaveBeenCalledWith(
      runtime,
      20,
    );
    expect(musicLibraryMocks.getRecentSongs).toHaveBeenCalledWith(runtime, 10);
  });
});
