import { describe, expect, it } from "vitest";
import musicPlugin from "./index";

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

  it("registers only the unified MUSIC action", () => {
    expect(musicPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC",
    ]);
  });

  it("declares MUSIC subactions structurally on the action parameter", () => {
    const action = musicPlugin.actions?.find((a) => a.name === "MUSIC");
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
    const action = musicPlugin.actions?.find((a) => a.name === "MUSIC");
    expect(action?.descriptionCompressed).toBe(
      "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
    );
  });
});
