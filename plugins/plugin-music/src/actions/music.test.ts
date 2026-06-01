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

function resolved(text: string, data: Record<string, unknown> = {}): ActionResult {
  return { success: true, text, data };
}

describe("MUSIC umbrella action dispatch", () => {
  it.each([
    ["next", "skip"],
    ["unpause", "resume"],
    ["clear_queue", "stop"],
  ])("dispatches playback alias %s as op=%s", async (alias, expectedOp) => {
    const handler = vi.spyOn(playbackOp, "handler").mockResolvedValue(
      resolved(`playback ${expectedOp}`),
    );
    const callback = vi.fn();

    const result = await musicAction.handler?.(
      runtime(),
      message(""),
      undefined,
      { parameters: { action: alias } },
      callback,
    );

    expect(result).toMatchObject({ success: true, text: `playback ${expectedOp}` });
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ op: expectedOp }),
      expect.any(Function),
    );

    handler.mockRestore();
  });

  it("routes legacy library aliases to canonical music library operations", async () => {
    const handler = vi.spyOn(musicLibraryAction, "handler").mockResolvedValue(
      resolved("searched"),
    );

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
    const handler = vi.spyOn(playAudio, "handler").mockImplementation(
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
    const routing = vi.spyOn(manageRouting, "handler").mockResolvedValue(
      resolved("routing"),
    );
    const zones = vi.spyOn(manageZones, "handler").mockResolvedValue(
      resolved("zones"),
    );

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
      expect.objectContaining({ action: "manage_zones", targetIds: ["zone-a"] }),
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
