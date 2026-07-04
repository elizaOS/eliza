/**
 * Playlist operation tests for structured names and destructive confirmation.
 *
 * They prevent playlist mutations from being inferred from prose alone.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handlePlaylistOp, validatePlaylistOp } from "./playlistOp";

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn().mockResolvedValue(undefined),
    setCache: vi.fn().mockResolvedValue(undefined),
    deleteCache: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("playlistOp structured params", () => {
  it("does not validate English playlist prose without structured operation params", async () => {
    await expect(
      validatePlaylistOp(
        runtime(),
        message('delete playlist "Favorites"'),
        undefined,
        undefined,
      ),
    ).resolves.toBe(false);

    await expect(
      validatePlaylistOp(
        runtime(),
        message("プレイリスト Favorites を削除して"),
        undefined,
        { parameters: { subaction: "delete" } },
      ),
    ).resolves.toBe(true);
  });

  it("does not parse playlist names from message prose", async () => {
    const deletePlaylist = vi.fn();
    const callback = vi.fn();
    const musicLibrary = {
      loadPlaylists: vi.fn().mockResolvedValue([
        {
          id: "playlist-id",
          name: "Favorites",
          tracks: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      deletePlaylist,
    };

    const result = await handlePlaylistOp(
      runtime({
        getService: vi.fn((name) =>
          name === "musicLibrary" ? musicLibrary : null,
        ),
      }),
      message('delete playlist "Favorites"'),
      undefined,
      { parameters: { subaction: "delete" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Missing playlist name",
    });
    expect(deletePlaylist).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("Please specify which playlist to delete"),
      source: "test",
    });
  });

  it("uses structured playlist names when provided", async () => {
    const deletePlaylist = vi.fn();
    const callback = vi.fn();
    const musicLibrary = {
      loadPlaylists: vi.fn().mockResolvedValue([
        {
          id: "playlist-id",
          name: "Favorites",
          tracks: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      deletePlaylist,
    };

    const result = await handlePlaylistOp(
      runtime({
        getService: vi.fn((name) =>
          name === "musicLibrary" ? musicLibrary : null,
        ),
      }),
      message("削除して"),
      undefined,
      { parameters: { subaction: "delete", playlistName: "Roadtrip" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Playlist not found",
    });
    expect(deletePlaylist).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining('playlist named "Roadtrip"'),
      source: "test",
    });
  });

  it("does not parse add song or playlist targets from message prose", async () => {
    const callback = vi.fn();

    const result = await handlePlaylistOp(
      runtime(),
      message("add Bohemian Rhapsody to playlist Favorites"),
      undefined,
      { parameters: { subaction: "add" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Missing song name",
    });
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("Please specify what song to add"),
      source: "test",
    });
  });
});
