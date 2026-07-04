/**
 * Compression-shape tests for the music plugin's public action and provider
 * surface using a deterministic in-memory runtime harness.
 */
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import musicPlugin from "./index";

function musicAction() {
  const action = musicPlugin.actions?.find((a) => a.name === "MUSIC");
  expect(action).toBeDefined();
  if (!action) throw new Error("MUSIC action not registered");
  return action;
}

function message(text = ""): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text, source: "test" },
  } as Memory;
}

describe("music plugin compression", () => {
  it("registers library + playback providers", () => {
    expect(musicPlugin.providers?.map((provider) => provider.name)).toEqual([
      "MUSIC_INFO",
      "WIKIPEDIA_MUSIC",
      "MUSIC_LIBRARY",
      "musicPlaylists",
      "musicQueue",
    ]);
  });

  it("registers only the MUSIC action", () => {
    expect(musicPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC",
    ]);
  });

  it("declares MUSIC subactions structurally on the action parameter", () => {
    const action = musicAction();
    const actionParameter = action?.parameters?.find(
      (parameter) => parameter.name === "action",
    );

    expect(actionParameter?.schema).toMatchObject({
      enum: [
        "play",
        "pause",
        "resume",
        "skip",
        "stop",
        "queue_view",
        "queue_add",
        "queue_clear",
        "playlist_play",
        "playlist_save",
        "playlist_delete",
        "playlist_add",
        "search",
        "play_query",
        "download",
        "play_audio",
        "set_routing",
        "set_zone",
        "generate",
        "extend",
        "custom_generate",
      ],
    });
  });

  it("exposes MUSIC descriptionCompressed", () => {
    const action = musicAction();
    expect(action?.descriptionCompressed).toBe(
      "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save/playlist_delete/playlist_add, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
    );
  });

  it("routes playlist_delete through the MUSIC umbrella", async () => {
    const action = musicAction();
    const callbacks: string[] = [];
    const callback: HandlerCallback = async ({ text }) => {
      callbacks.push(text ?? "");
      return [];
    };
    const runtime = {
      getService: (name: string) =>
        name === "musicLibrary" ? { loadPlaylists: async () => [] } : null,
    } as unknown as IAgentRuntime;

    const result = await action.handler?.(
      runtime,
      message(),
      undefined,
      { action: "playlist_delete", playlistName: "Focus" },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      error: "No playlists available",
    });
    expect(callbacks).toEqual([
      "You don't have any saved playlists to delete.",
    ]);
  });

  it("routes playlist_add through the MUSIC umbrella", async () => {
    const action = musicAction();
    const callbacks: string[] = [];
    const callback: HandlerCallback = async ({ text }) => {
      callbacks.push(text ?? "");
      return [];
    };
    const runtime = {} as unknown as IAgentRuntime;

    const result = await action.handler?.(
      runtime,
      message(),
      undefined,
      {
        action: "playlist_add",
        playlistName: "Focus",
        song: "Aphex Twin Avril 14th",
      },
      callback,
    );

    expect(result?.data).toMatchObject({
      requiresConfirmation: true,
      awaitingUserInput: true,
    });
    expect(callbacks[0]).toContain(
      'Confirmation required before adding "Aphex Twin Avril 14th" to playlist "Focus".',
    );
  });
});
