import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const GITHUB_PULL_REQUESTS_SEARCH_CATEGORY: SearchCategoryRegistration =
  {
    category: "github_pull_requests",
    label: "GitHub pull requests",
    description:
      "Search GitHub pull requests in a repo or across accessible repositories.",
    contexts: ["code", "automation"],
    filters: [
      { name: "query", label: "Query", type: "string" },
      {
        name: "repo",
        label: "Repository",
        description:
          "Repository in owner/name format. Omit to search accessible repositories.",
        type: "string",
      },
      {
        name: "state",
        label: "State",
        description: "Pull request state.",
        type: "enum",
        default: "open",
        options: [
          { label: "Open", value: "open" },
          { label: "Closed", value: "closed" },
          { label: "All", value: "all" },
        ],
      },
      {
        name: "author",
        label: "Author",
        description: "GitHub login to filter by.",
        type: "string",
      },
      {
        name: "as",
        label: "Identity",
        description: "Configured GitHub identity token to use.",
        type: "enum",
        default: "agent",
        options: [
          { label: "Agent", value: "agent" },
          { label: "User", value: "user" },
        ],
      },
      {
        name: "accountId",
        label: "Account",
        description:
          "Optional configured GitHub account id. Defaults by identity role.",
        type: "string",
      },
      {
        name: "limit",
        label: "Limit",
        description: "Maximum pull requests to return.",
        type: "number",
        default: 50,
      },
    ],
    resultSchemaSummary:
      "PRSummary[] with repo, number, title, author, state, and url.",
    capabilities: ["pull-requests", "issues-search", "repositories"],
    source: "plugin:github",
    serviceType: "github",
  };

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerGitHubSearchCategory(runtime: IAgentRuntime): void {
  if (
    !hasSearchCategory(runtime, GITHUB_PULL_REQUESTS_SEARCH_CATEGORY.category)
  ) {
    runtime.registerSearchCategory(GITHUB_PULL_REQUESTS_SEARCH_CATEGORY);
  }
}
