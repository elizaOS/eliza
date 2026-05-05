import { describe, expect, it } from "vitest";
import musicLibraryPlugin from "./index";
import { MusicLibraryService } from "./services/musicLibraryService";

describe("music library plugin compression", () => {
  it("registers one domain service and the compressed action set", () => {
    expect(musicLibraryPlugin.services).toEqual([MusicLibraryService]);
    expect(musicLibraryPlugin.actions?.map((action) => action.name)).toEqual([
      "PLAYLIST_OP",
      "PLAY_MUSIC_QUERY",
      "SEARCH_YOUTUBE",
      "DOWNLOAD_MUSIC",
    ]);
  });

  it("exposes the compressed PLAYLIST_OP descCompressed", () => {
    const action = musicLibraryPlugin.actions?.find(
      (a) => a.name === "PLAYLIST_OP",
    );
    expect(action?.descriptionCompressed).toBe(
      "Playlist ops: save, load, delete, add.",
    );
  });

  it("does not register instruction-only providers and exposes musicPlaylists", () => {
    expect(
      musicLibraryPlugin.providers?.map((provider) => provider.name),
    ).toEqual([
      "MUSIC_INFO",
      "WIKIPEDIA_MUSIC",
      "MUSIC_LIBRARY",
      "musicPlaylists",
    ]);
    expect(
      musicLibraryPlugin.providers?.some((provider) =>
        provider.name.endsWith("_INSTRUCTIONS"),
      ),
    ).toBe(false);
  });
});
