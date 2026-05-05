import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEXSCREENER_SEARCH_CATEGORY,
  registerDexScreenerSearchCategory,
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
    runtime: {
      getSearchCategory,
      registerSearchCategory,
    } as unknown as IAgentRuntime,
  };
}

describe("DexScreener search category", () => {
  it("registers token and pair search metadata", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerDexScreenerSearchCategory(runtime);
    registerDexScreenerSearchCategory(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("dexscreener")).toMatchObject({
      category: "dexscreener",
      serviceType: "dexscreener",
      source: "plugin:wallet:dexscreener",
    });
    expect(DEXSCREENER_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual([
      "query",
      "limit",
    ]);
  });
});
