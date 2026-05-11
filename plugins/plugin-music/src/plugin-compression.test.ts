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

  it("registers the unified MUSIC action with promoted subactions", () => {
    expect(musicPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC",
      "MUSIC_PLAY",
      "MUSIC_PAUSE",
      "MUSIC_RESUME",
      "MUSIC_SKIP",
      "MUSIC_STOP",
      "MUSIC_QUEUE_VIEW",
      "MUSIC_QUEUE_ADD",
      "MUSIC_QUEUE_CLEAR",
      "MUSIC_PLAYLIST_PLAY",
      "MUSIC_PLAYLIST_SAVE",
      "MUSIC_SEARCH",
      "MUSIC_PLAY_QUERY",
      "MUSIC_DOWNLOAD",
      "MUSIC_PLAY_AUDIO",
      "MUSIC_SET_ROUTING",
      "MUSIC_SET_ZONE",
      "MUSIC_GENERATE",
      "MUSIC_EXTEND",
      "MUSIC_CUSTOM_GENERATE",
    ]);
  });

  it("exposes MUSIC descriptionCompressed", () => {
    const action = musicPlugin.actions?.find((a) => a.name === "MUSIC");
    expect(action?.descriptionCompressed).toBe(
      "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
    );
  });
});
