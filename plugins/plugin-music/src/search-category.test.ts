import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  registerMusicLibrarySearchCategories,
  WIKIPEDIA_MUSIC_SEARCH_CATEGORY,
  YOUTUBE_SEARCH_CATEGORY,
} from "./search-category";

function createRuntime() {
  const categories = new Map<string, SearchCategoryRegistration>();
  const registerSearchCategory = vi.fn(
    (registration: SearchCategoryRegistration) => {
      categories.set(registration.category, registration);
    },
  );
  const getSearchCategory = vi.fn((category: string) => {
    const registration = categories.get(category);
    if (!registration) throw new Error(`Missing category ${category}`);
    return registration;
  });

  return {
    categories,
    registerSearchCategory,
    runtime: Object.assign(Object.create(null) as IAgentRuntime, {
      getSearchCategory,
      registerSearchCategory,
    }),
  };
}

describe("music library search categories", () => {
  it("registers YouTube and Wikipedia music search metadata", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerMusicLibrarySearchCategories(runtime);
    registerMusicLibrarySearchCategories(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(2);
    expect(categories.get("youtube")).toMatchObject({
      category: "youtube",
      serviceType: "musicLibrary",
      source: "plugin:music-library",
    });
    expect(categories.get("wikipedia_music")).toMatchObject({
      category: "wikipedia_music",
      serviceType: "musicLibrary",
      source: "plugin:music-library",
    });
    expect(YOUTUBE_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual(
      expect.arrayContaining(["query", "limit", "includeShorts"]),
    );
    expect(WIKIPEDIA_MUSIC_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual(
      expect.arrayContaining(["query", "entityType", "artist"]),
    );
  });
});
