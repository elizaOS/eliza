import { describe, expect, it } from "vitest";
import musicLibraryPlugin from "./index";
import { MusicLibraryService } from "./services/musicLibraryService";

describe("music library plugin compression", () => {
  it("registers one domain service and three router actions", () => {
    expect(musicLibraryPlugin.services).toEqual([MusicLibraryService]);
    expect(musicLibraryPlugin.actions?.map((action) => action.name)).toEqual([
      "MUSIC_LIBRARY",
      "MUSIC_PLAYLIST",
      "MUSIC_METADATA_SEARCH",
    ]);
  });

  it("does not register instruction-only providers", () => {
    expect(
      musicLibraryPlugin.providers?.map((provider) => provider.name),
    ).toEqual(["MUSIC_INFO", "WIKIPEDIA_MUSIC", "MUSIC_LIBRARY"]);
    expect(
      musicLibraryPlugin.providers?.some((provider) =>
        provider.name.endsWith("_INSTRUCTIONS"),
      ),
    ).toBe(false);
  });
});
