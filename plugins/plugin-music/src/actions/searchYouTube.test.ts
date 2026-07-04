/**
 * YouTube search action tests for structured query handling.
 *
 * They verify validation and search execution do not mine free-form message
 * text for a target query.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleSearchYouTube, validateSearchYouTube } from "./searchYouTube";

function message(text = ""): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    createMemory: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("SEARCH_YOUTUBE action", () => {
  it("does not validate English prose without a structured query", async () => {
    await expect(
      validateSearchYouTube(
        runtime(),
        message("Find the YouTube link for Surefire by Wilderado"),
        undefined,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("validates structured query parameters independent of message language", async () => {
    await expect(
      validateSearchYouTube(runtime(), message("YouTubeで探して"), undefined, {
        parameters: { query: "Surefire Wilderado" },
      }),
    ).resolves.toBe(true);
  });

  it("does not extract a search query from message text in the handler", async () => {
    const searchYouTube = vi.fn();
    const callback = vi.fn(async () => undefined);

    const result = await handleSearchYouTube(
      runtime({
        getService: vi.fn((name: string) =>
          name === "musicLibrary" ? { searchYouTube } : null,
        ),
      }),
      message("search youtube for bohemian rhapsody"),
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Missing search query",
    });
    expect(searchYouTube).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("couldn't understand"),
      source: "test",
    });
  });

  it("searches YouTube using the structured query and limit", async () => {
    const searchYouTube = vi.fn(async () => [
      {
        title: "Surefire",
        channel: "Wilderado",
        url: "https://youtu.be/surefire",
      },
    ]);
    const createMemory = vi.fn(async () => undefined);
    const callback = vi.fn(async () => undefined);

    const result = await handleSearchYouTube(
      runtime({
        createMemory,
        getService: vi.fn((name: string) =>
          name === "musicLibrary" ? { searchYouTube } : null,
        ),
      }),
      message("find anything"),
      undefined,
      { parameters: { searchQuery: "Surefire Wilderado", limit: "1" } },
      callback,
    );

    expect(searchYouTube).toHaveBeenCalledWith("Surefire Wilderado", {
      limit: 1,
    });
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          searchQuery: "Surefire Wilderado",
          resultUrl: "https://youtu.be/surefire",
        }),
      }),
      "messages",
    );
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("https://youtu.be/surefire"),
      actions: ["SEARCH_YOUTUBE_RESPONSE"],
      source: "test",
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        searchQuery: "Surefire Wilderado",
        resultUrl: "https://youtu.be/surefire",
      },
    });
  });
});
