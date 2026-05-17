import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LINEAR_ISSUES_SEARCH_CATEGORY, registerLinearSearchCategory } from "./search-category";

function createRuntime() {
  const categories = new Map<string, SearchCategoryRegistration>();
  const registerSearchCategory = vi.fn((registration: SearchCategoryRegistration) => {
    categories.set(registration.category, registration);
  });
  const getSearchCategory = vi.fn((category: string) => {
    const registration = categories.get(category);
    if (!registration) throw new Error(`Missing category ${category}`);
    return registration;
  });

  return {
    categories,
    registerSearchCategory,
    runtime: { getSearchCategory, registerSearchCategory } as IAgentRuntime,
  };
}

describe("Linear search category", () => {
  it("registers Linear issue search metadata once", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerLinearSearchCategory(runtime);
    registerLinearSearchCategory(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("linear_issues")).toMatchObject({
      category: "linear_issues",
      serviceType: "linear",
      source: "plugin:linear",
    });
    expect(LINEAR_ISSUES_SEARCH_CATEGORY.filters?.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "query",
        "state",
        "assignee",
        "label",
        "project",
        "team",
        "priority",
        "limit",
      ])
    );
  });
});
