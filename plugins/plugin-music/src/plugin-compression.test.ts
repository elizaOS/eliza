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

  it("registers the unified MUSIC action only", () => {
    expect(musicPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC",
    ]);
  });

  it("exposes MUSIC descriptionCompressed", () => {
    const action = musicPlugin.actions?.find((a) => a.name === "MUSIC");
    expect(action?.descriptionCompressed).toBe(
      "Flat op: playlist/play_query/search_youtube/download/pause/resume/skip/stop/queue/play_audio/routing/zones.",
    );
  });
});
