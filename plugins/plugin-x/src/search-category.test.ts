import type {
  IAgentRuntime,
  SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerXSearchCategory, X_SEARCH_CATEGORY } from "./search-category";

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

describe("X search category", () => {
  it("registers recent-post search metadata", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerXSearchCategory(runtime);
    registerXSearchCategory(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("x")).toMatchObject({
      category: "x",
      serviceType: "x",
      source: "plugin:x",
    });
    expect(X_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual([
      "query",
      "maxResults",
    ]);
  });
});
