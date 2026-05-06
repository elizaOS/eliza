import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  registerShopifySearchCategory,
  SHOPIFY_STORE_SEARCH_CATEGORY,
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

describe("Shopify search category", () => {
  it("registers store search filters", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerShopifySearchCategory(runtime);
    registerShopifySearchCategory(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("shopify_store")).toMatchObject({
      category: "shopify_store",
      serviceType: "shopify",
      source: "plugin:shopify",
    });
    expect(
      SHOPIFY_STORE_SEARCH_CATEGORY.filters?.find((f) => f.name === "scope")
        ?.options,
    ).toEqual(
      expect.arrayContaining([
        { label: "All", value: "all" },
        { label: "Products", value: "products" },
        { label: "Orders", value: "orders" },
        { label: "Customers", value: "customers" },
      ]),
    );
  });
});
