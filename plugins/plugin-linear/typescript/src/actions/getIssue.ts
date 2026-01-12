import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { Issue, IssueLabel } from "@linear/sdk";
import { getIssueTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";

export const getIssueAction: Action = {
  name: "GET_LINEAR_ISSUE",
  description: "Get details of a specific Linear issue",
  similes: [
    "get-linear-issue",
    "show-linear-issue",
    "view-linear-issue",
    "check-linear-issue",
    "find-linear-issue",
  ],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Show me issue ENG-123",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll get the details for issue ENG-123.",
          actions: ["GET_LINEAR_ISSUE"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "What's the status of the login bug?",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "Let me find the login bug issue for you.",
          actions: ["GET_LINEAR_ISSUE"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Show me the latest high priority issue assigned to Sarah",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll find the latest high priority issue assigned to Sarah.",
          actions: ["GET_LINEAR_ISSUE"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const apiKey = runtime.getSetting("LINEAR_API_KEY");
    return !!apiKey;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please specify which issue you want to see.";
        await callback?.({
          text: errorMessage,
          source: message.content.source,
        });
        return {
          text: errorMessage,
          success: false,
        };
      }

      const prompt = getIssueTemplate.replace("{{userMessage}}", content);
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: prompt,
      });

      if (!response) {
        const issueMatch = content.match(/(\w+-\d+)/);
        if (issueMatch) {
          const issue = await linearService.getIssue(issueMatch[1]);
          return await formatIssueResponse(issue, callback, message);
        }
        throw new Error("Could not understand issue reference");
      }

      try {
        const parsed = JSON.parse(
          response
            .replace(/^```(?:json)?\n?/, "")
            .replace(/\n?```$/, "")
            .trim()
        );

        if (parsed.directId) {
          const issue = await linearService.getIssue(parsed.directId);
          return await formatIssueResponse(issue, callback, message);
        }

        if (parsed.searchBy && Object.keys(parsed.searchBy).length > 0) {
          const filters: Record<string, unknown> = {};

          if (parsed.searchBy.title) {
            filters.query = parsed.searchBy.title;
          }

          if (parsed.searchBy.assignee) {
            filters.assignee = [parsed.searchBy.assignee];
          }

          if (parsed.searchBy.priority) {
            const priorityMap: Record<string, number> = {
              urgent: 1,
              high: 2,
              normal: 3,
              low: 4,
              "1": 1,
              "2": 2,
              "3": 3,
              "4": 4,
            };
            const priority = priorityMap[parsed.searchBy.priority.toLowerCase()];
            if (priority) {
              filters.priority = [priority];
            }
          }

          if (parsed.searchBy.team) {
            filters.team = parsed.searchBy.team;
          }

          if (parsed.searchBy.state) {
            filters.state = [parsed.searchBy.state];
          }

          const defaultTeamKey = runtime.getSetting("LINEAR_DEFAULT_TEAM_KEY") as string;
          if (defaultTeamKey && !filters.team) {
            filters.team = defaultTeamKey;
          }

          const issues = await linearService.searchIssues({
            ...filters,
            limit: parsed.searchBy.recency ? 10 : 5,
          });

          if (issues.length === 0) {
            const noResultsMessage = "No issues found matching your criteria.";
            await callback?.({
              text: noResultsMessage,
              source: message.content.source,
            });
            return {
              text: noResultsMessage,
              success: false,
            };
          }

          if (parsed.searchBy.recency) {
            issues.sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
          }

          if (parsed.searchBy.recency && issues.length > 0) {
            return await formatIssueResponse(issues[0], callback, message);
          }

          if (issues.length === 1) {
            return await formatIssueResponse(issues[0], callback, message);
          }

          const issueList = await Promise.all(
            issues.slice(0, 5).map(async (issue, index) => {
              const state = await issue.state;
              return `${index + 1}. ${issue.identifier}: ${issue.title} (${state?.name || "No state"})`;
            })
          );

          const clarifyMessage = `Found ${issues.length} issues matching your criteria:\n${issueList.join("\n")}\n\nPlease specify which one you want to see by its ID.`;
          await callback?.({
            text: clarifyMessage,
            source: message.content.source,
          });

          return {
            text: clarifyMessage,
            success: true,
            data: {
              multipleResults: true,
              issues: issues.slice(0, 5).map((i) => ({
                id: i.id,
                identifier: i.identifier,
                title: i.title,
              })),
            },
          };
        }
      } catch (parseError) {
        logger.warn("Failed to parse LLM response, falling back to regex:", parseError);
        const issueMatch = content.match(/(\w+-\d+)/);
        if (issueMatch) {
          const issue = await linearService.getIssue(issueMatch[1]);
          return await formatIssueResponse(issue, callback, message);
        }
      }

      const errorMessage =
        "Could not understand which issue you want to see. Please provide an issue ID (e.g., ENG-123) or describe it more specifically.";
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    } catch (error) {
      logger.error("Failed to get issue:", error);
      const errorMessage = `❌ Failed to get issue: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};

async function formatIssueResponse(
  issue: Issue,
  callback: HandlerCallback | undefined,
  message: Memory
): Promise<ActionResult> {
  const assignee = await issue.assignee;
  const state = await issue.state;
  const team = await issue.team;
  const labels = await issue.labels();
  const project = await issue.project;

  const issueDetails = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    estimate: issue.estimate,
    assignee: assignee
      ? {
          id: assignee.id,
          name: assignee.name,
          email: assignee.email,
        }
      : null,
    state: state
      ? {
          id: state.id,
          name: state.name,
          type: state.type,
          color: state.color,
        }
      : null,
    team: team
      ? {
          id: team.id,
          name: team.name,
          key: team.key,
        }
      : null,
    labels: labels.nodes.map((label: IssueLabel) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
    project: project
      ? {
          id: project.id,
          name: project.name,
          description: project.description,
        }
      : null,
  };

  const priorityLabels = ["", "Urgent", "High", "Normal", "Low"];
  const priority = priorityLabels[issue.priority || 0] || "No priority";

  const labelText =
    issueDetails.labels.length > 0
      ? `Labels: ${issueDetails.labels.map((l) => l.name).join(", ")}`
      : "";

  const issueMessage = `📋 **${issue.identifier}: ${issue.title}**
  
Status: ${state?.name || "No status"}
Priority: ${priority}
Team: ${team?.name || "No team"}
Assignee: ${assignee?.name || "Unassigned"}
${issue.dueDate ? `Due: ${new Date(issue.dueDate).toLocaleDateString()}` : ""}
${labelText}
${project ? `Project: ${project.name}` : ""}

${issue.description || "No description"}

View in Linear: ${issue.url}`;

  await callback?.({
    text: issueMessage,
    source: message.content.source,
  });

  const serializedIssue = {
    ...issueDetails,
    createdAt:
      issueDetails.createdAt instanceof Date
        ? issueDetails.createdAt.toISOString()
        : issueDetails.createdAt,
    updatedAt:
      issueDetails.updatedAt instanceof Date
        ? issueDetails.updatedAt.toISOString()
        : issueDetails.updatedAt,
    dueDate: issueDetails.dueDate
      ? issueDetails.dueDate instanceof Date
        ? issueDetails.dueDate.toISOString()
        : issueDetails.dueDate
      : null,
  };

  return {
    text: `Retrieved issue ${issue.identifier}: ${issue.title}`,
    success: true,
    data: { issue: serializedIssue },
  };
}
