import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_PULL_REQUESTS_SEARCH_CATEGORY,
  registerGitHubSearchCategory,
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

describe("GitHub search category", () => {
  it("registers pull request search filters", () => {
    const { categories, registerSearchCategory, runtime } = createRuntime();

    registerGitHubSearchCategory(runtime);
    registerGitHubSearchCategory(runtime);

    expect(registerSearchCategory).toHaveBeenCalledTimes(1);
    expect(categories.get("github_pull_requests")).toMatchObject({
      category: "github_pull_requests",
      serviceType: "github",
      source: "plugin:github",
    });
    expect(
      GITHUB_PULL_REQUESTS_SEARCH_CATEGORY.filters?.map(
        (filter) => filter.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "query",
        "repo",
        "state",
        "author",
        "as",
        "accountId",
        "limit",
      ]),
    );
  });
});
