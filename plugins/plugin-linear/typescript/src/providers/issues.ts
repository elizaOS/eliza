import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { Issue } from "@linear/sdk";
import type { LinearService } from "../services/linear";

export const linearIssuesProvider: Provider = {
  name: "LINEAR_ISSUES",
  description: "Provides context about recent Linear issues",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        return {
          text: "Linear service is not available",
        };
      }

      const issues = await linearService.searchIssues({ limit: 10 });

      if (issues.length === 0) {
        return {
          text: "No recent Linear issues found",
        };
      }

      const issuesList = await Promise.all(
        issues.map(async (issue: Issue) => {
          const [assignee, state] = await Promise.all([issue.assignee, issue.state]);

          return `- ${issue.identifier}: ${issue.title} (${state?.name || "Unknown"}, ${assignee?.name || "Unassigned"})`;
        })
      );

      const text = `Recent Linear Issues:\n${issuesList.join("\n")}`;

      return {
        text,
        data: {
          issues: issues.map((issue: Issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
          })),
        },
      };
    } catch (_error) {
      return {
        text: "Error retrieving Linear issues",
      };
    }
  },
};
