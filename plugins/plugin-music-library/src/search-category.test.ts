import type {
  IAgentRuntime,
  SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  registerMusicLibrarySearchCategories,
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
    runtime: { getSearchCategory, registerSearchCategory } as unknown as
      IAgentRuntime,
  };
}

describe("music library search categories", () => {
  it("registers YouTube search metadata", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerMusicLibrarySearchCategories(runtime);
    registerMusicLibrarySearchCategories(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("youtube")).toMatchObject({
      category: "youtube",
      serviceType: "youtubeSearch",
      source: "plugin:music-library",
    });
    expect(YOUTUBE_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual(
      expect.arrayContaining(["query", "limit", "includeShorts"]),
    );
  });
});
