import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { manageRouting } from "./manageRouting";
import { manageZones } from "./manageZones";
import { musicAction } from "./music";
import { musicLibraryAction } from "./musicLibrary";
import { playAudio } from "./playAudio";
import { playbackOp } from "./playbackOp";

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    useModel: vi.fn(),
    ...overrides,
  } as unknown as IAgentRuntime;
}

function message(text = "music please"): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function resolved(
  text: string,
  data: Record<string, unknown> = {},
): ActionResult {
  return { success: true, text, data };
}

describe("MUSIC umbrella action dispatch", () => {
  it("validates explicit structured action without model extraction", async () => {
    const useModel = vi.fn();

    await expect(
      musicAction.validate?.(
        runtime({ useModel } as unknown as Partial<IAgentRuntime>),
        message(""),
        undefined,
        { parameters: { action: "pause" } },
      ),
    ).resolves.toBe(true);

    expect(useModel).not.toHaveBeenCalled();
  });

  it("validates by selected music context without classifying natural language", async () => {
    const useModel = vi.fn();
    const state = {
      values: { selectedContexts: ["media"] },
    };

    await expect(
      musicAction.validate?.(
        runtime({ useModel } as unknown as Partial<IAgentRuntime>),
        message("pause the music"),
        state as never,
        undefined,
      ),
    ).resolves.toBe(true);

    expect(useModel).not.toHaveBeenCalled();
  });

  it.each([
    ["next", "skip"],
    ["unpause", "resume"],
    ["clear_queue", "stop"],
  ])("dispatches playback alias %s as op=%s", async (alias, expectedOp) => {
    const handler = vi
      .spyOn(playbackOp, "handler")
      .mockResolvedValue(resolved(`playback ${expectedOp}`));
    const callback = vi.fn();

    const result = await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: alias } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      text: `playback ${expectedOp}`,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ op: expectedOp }),
      expect.any(Function),
    );

    handler.mockRestore();
  });

  it("uses model structured extraction when action params are absent", async () => {
    const handler = vi
      .spyOn(playbackOp, "handler")
      .mockResolvedValue(resolved("playback pause"));
    const playAudioHandler = vi.spyOn(playAudio, "handler");
    const useModel = vi
      .fn()
      .mockResolvedValue("<response><action>pause</action></response>");
    const callback = vi.fn();
    const state = {
      values: { selectedContexts: ["media"] },
    };

    const result = await musicAction.handler?.(
      runtime({ useModel } as unknown as Partial<IAgentRuntime>),
      message("pausa la música"),
      state as never,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      text: "playback pause",
    });
    expect(useModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        prompt: expect.stringContaining("pausa la música"),
      }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      state,
      expect.objectContaining({ op: "pause" }),
      expect.any(Function),
    );
    expect(playAudioHandler).not.toHaveBeenCalled();

    handler.mockRestore();
    playAudioHandler.mockRestore();
  });

  it("does not use sub-handler English regexes before model extraction", async () => {
    const handler = vi.spyOn(musicLibraryAction, "handler");
    const useModel = vi
      .fn()
      .mockResolvedValue(
        "<response><action>not_a_music_action</action></response>",
      );
    const callback = vi.fn();

    const result = await musicAction.handler?.(
      runtime({
        getService: vi.fn((serviceName: string) =>
          serviceName === "musicLibrary" ? {} : null,
        ),
        useModel,
      } as unknown as Partial<IAgentRuntime>),
      message("find the YouTube link for Surefire by Wilderado"),
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("Could not classify a music subaction"),
    });
    expect(useModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        prompt: expect.stringContaining("Surefire by Wilderado"),
      }),
    );
    expect(handler).not.toHaveBeenCalled();

    handler.mockRestore();
  });

  it("does not fall back to English regex routing when model extraction fails", async () => {
    const handler = vi.spyOn(playbackOp, "handler");
    const useModel = vi
      .fn()
      .mockResolvedValue(
        "<response><action>not_a_music_action</action></response>",
      );
    const callback = vi.fn();

    const result = await musicAction.handler?.(
      runtime({ useModel } as unknown as Partial<IAgentRuntime>),
      message("pause the music"),
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("Could not classify a music subaction"),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      text: result?.text,
      source: "test",
    });

    handler.mockRestore();
  });

  it("routes legacy library aliases to canonical music library operations", async () => {
    const handler = vi
      .spyOn(musicLibraryAction, "handler")
      .mockResolvedValue(resolved("searched"));

    await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: "youtube_search", query: "burial archangel" } },
      vi.fn(),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({
        subaction: "search_youtube",
        query: "burial archangel",
      }),
      expect.any(Function),
    );

    handler.mockRestore();
  });

  it("attributes delegated callbacks to the routed action name", async () => {
    const handler = vi
      .spyOn(playAudio, "handler")
      .mockImplementation(
        async (_runtime, _message, _state, _options, callback) => {
          await callback?.({ text: "playing", source: "test" });
          return resolved("playing");
        },
      );
    const callback = vi.fn();

    await musicAction.handler?.(
      runtime(),
      message("play https://example.com/song.mp3"),
      undefined,
      { parameters: { action: "stream", url: "https://example.com/song.mp3" } },
      callback,
    );

    expect(callback).toHaveBeenCalledWith(
      { text: "playing", source: "test" },
      playAudio.name,
    );

    handler.mockRestore();
  });

  it("routes explicit routing and zone aliases to their dedicated handlers", async () => {
    const routing = vi
      .spyOn(manageRouting, "handler")
      .mockResolvedValue(resolved("routing"));
    const zones = vi
      .spyOn(manageZones, "handler")
      .mockResolvedValue(resolved("zones"));

    await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: "route_audio", sourceId: "source-a" } },
      vi.fn(),
    );
    await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: "manage_zones", targetIds: ["zone-a"] } },
      vi.fn(),
    );

    expect(routing).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ action: "route_audio", sourceId: "source-a" }),
      expect.any(Function),
    );
    expect(zones).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({
        action: "manage_zones",
        targetIds: ["zone-a"],
      }),
      expect.any(Function),
    );

    routing.mockRestore();
    zones.mockRestore();
  });

  it("returns a useful classification failure with the supported subactions", async () => {
    const callback = vi.fn();
    const result = await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: "not-a-real-action" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("Could not classify a music subaction"),
    });
    expect(result?.text).toContain("custom_generate");
    expect(callback).toHaveBeenCalledWith({
      text: result?.text,
      source: "test",
    });
  });
});
