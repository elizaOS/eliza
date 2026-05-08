import { describe, expect, it } from "vitest";
import musicLibraryPlugin from "./index";
import { MusicLibraryService } from "./services/musicLibraryService";

describe("music library plugin compression", () => {
  it("registers one domain service and the compressed action set", () => {
    expect(musicLibraryPlugin.services).toEqual([MusicLibraryService]);
    expect(musicLibraryPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC_LIBRARY",
    ]);
  });

  it("exposes the compressed MUSIC_LIBRARY descCompressed", () => {
    const action = musicLibraryPlugin.actions?.find(
      (a) => a.name === "MUSIC_LIBRARY",
    );
    expect(action?.descriptionCompressed).toBe(
      "Music library ops: playlist(subaction save/load/delete/add), play-query, search-youtube, download. Mutations require confirmed:true.",
    );
  });

  it("keeps legacy action names as MUSIC_LIBRARY similes", () => {
    const action = musicLibraryPlugin.actions?.find(
      (a) => a.name === "MUSIC_LIBRARY",
    );
    expect(action?.similes).toEqual(
      expect.arrayContaining([
        "PLAYLIST",
        "PLAYLIST",
        "PLAY_MUSIC_QUERY",
        "SEARCH_YOUTUBE",
        "DOWNLOAD_MUSIC",
      ]),
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
