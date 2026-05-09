import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const LINEAR_ISSUES_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "linear_issues",
  label: "Linear issues",
  description: "Search Linear issues by text and issue metadata filters.",
  contexts: ["automation", "system"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "state",
      label: "States",
      description: "Issue workflow state names.",
      type: "string[]",
    },
    {
      name: "assignee",
      label: "Assignees",
      description: "Assignee names or emails.",
      type: "string[]",
    },
    {
      name: "label",
      label: "Labels",
      description: "Linear issue label names.",
      type: "string[]",
    },
    {
      name: "project",
      label: "Project",
      description: "Linear project name or identifier.",
      type: "string",
    },
    {
      name: "team",
      label: "Team",
      description: "Linear team key, name, or identifier.",
      type: "string",
    },
    {
      name: "priority",
      label: "Priorities",
      description: "Linear priorities: 1 urgent, 2 high, 3 normal, 4 low.",
      type: "number[]",
    },
    {
      name: "limit",
      label: "Limit",
      description: "Maximum issues to return.",
      type: "number",
      default: 10,
    },
    {
      name: "accountId",
      label: "Account",
      description:
        "Optional Linear account id. Defaults to LINEAR_DEFAULT_ACCOUNT_ID or the legacy single API key.",
      type: "string",
    },
  ],
  resultSchemaSummary:
    "LinearIssue[] with id, identifier, title, description, state, assignee, labels, priority, team, project, url, and updatedAt.",
  capabilities: ["issues", "filters", "workflow", "team"],
  source: "plugin:linear",
  serviceType: "linear",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerLinearSearchCategory(runtime: IAgentRuntime): void {
  if (!hasSearchCategory(runtime, LINEAR_ISSUES_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(LINEAR_ISSUES_SEARCH_CATEGORY);
  }
}
