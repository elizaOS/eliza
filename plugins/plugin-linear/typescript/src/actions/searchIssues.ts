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
import { searchIssuesTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";
import type { LinearSearchFilters, SearchIssuesParameters } from "../types/index.js";

const searchTemplate = searchIssuesTemplate;

export const searchIssuesAction: Action = {
  name: "SEARCH_LINEAR_ISSUES",
  description: "Search for issues in Linear with various filters",
  similes: [
    "search-linear-issues",
    "find-linear-issues",
    "query-linear-issues",
    "list-linear-issues",
  ],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Show me all open bugs",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll search for all open bug issues in Linear.",
          actions: ["SEARCH_LINEAR_ISSUES"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "What is John working on?",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll find the issues assigned to John.",
          actions: ["SEARCH_LINEAR_ISSUES"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Show me high priority issues created this week",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll search for high priority issues created this week.",
          actions: ["SEARCH_LINEAR_ISSUES"],
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
        const errorMessage = "Please provide search criteria for issues.";
        await callback?.({
          text: errorMessage,
          source: message.content.source,
        });
        return {
          text: errorMessage,
          success: false,
        };
      }

      let filters: LinearSearchFilters = {};

      const params = _options?.parameters as SearchIssuesParameters | undefined;
      if (params?.filters) {
        filters = params.filters;
      } else {
        const prompt = searchTemplate.replace("{{userMessage}}", content);

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt,
        });

        if (!response) {
          filters = { query: content };
        } else {
          try {
            const cleanedResponse = response
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "")
              .trim();
            const parsed = JSON.parse(cleanedResponse);

            filters = {
              query: parsed.query,
              limit: parsed.limit || 10,
            };

            if (parsed.states && parsed.states.length > 0) {
              filters.state = parsed.states;
            }

            if (parsed.assignees && parsed.assignees.length > 0) {
              const processedAssignees = [];
              for (const assignee of parsed.assignees) {
                if (assignee.toLowerCase() === "me") {
                  try {
                    const currentUser = await linearService.getCurrentUser();
                    processedAssignees.push(currentUser.email);
                  } catch {
                    logger.warn('Could not resolve "me" to current user');
                  }
                } else {
                  processedAssignees.push(assignee);
                }
              }
              if (processedAssignees.length > 0) {
                filters.assignee = processedAssignees;
              }
            }

            if (parsed.hasAssignee === false) {
              filters.query = filters.query ? `${filters.query} unassigned` : "unassigned";
            }

            if (parsed.priorities && parsed.priorities.length > 0) {
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
              const priorities = parsed.priorities
                .map((p: string) => priorityMap[p.toLowerCase()])
                .filter(Boolean);
              if (priorities.length > 0) {
                filters.priority = priorities;
              }
            }

            if (parsed.teams && parsed.teams.length > 0) {
              filters.team = parsed.teams[0];
            }

            if (parsed.labels && parsed.labels.length > 0) {
              filters.label = parsed.labels;
            }

            Object.keys(filters).forEach((key) => {
              if (filters[key as keyof LinearSearchFilters] === undefined) {
                delete filters[key as keyof LinearSearchFilters];
              }
            });
          } catch (parseError) {
            logger.error("Failed to parse search filters:", parseError);
            // Fallback to simple search
            filters = { query: content };
          }
        }
      }

      if (!filters.team) {
        const defaultTeamKey = runtime.getSetting("LINEAR_DEFAULT_TEAM_KEY") as string;
        if (defaultTeamKey) {
          const searchingAllIssues =
            content.toLowerCase().includes("all") &&
            (content.toLowerCase().includes("issue") ||
              content.toLowerCase().includes("bug") ||
              content.toLowerCase().includes("task"));

          if (!searchingAllIssues) {
            filters.team = defaultTeamKey;
            logger.info(`Applying default team filter: ${defaultTeamKey}`);
          }
        }
      }

      filters.limit = params?.limit ?? filters.limit ?? 10;

      const issues = await linearService.searchIssues(filters);

      if (issues.length === 0) {
        const noResultsMessage = "No issues found matching your search criteria.";
        await callback?.({
          text: noResultsMessage,
          source: message.content.source,
        });
        return {
          text: noResultsMessage,
          success: true,
          data: {
            issues: [],
            filters: filters ? { ...filters } : undefined,
            count: 0,
          },
        };
      }

      const issueList = await Promise.all(
        issues.map(async (issue, index) => {
          const state = await issue.state;
          const assignee = await issue.assignee;
          const priorityLabels = ["", "Urgent", "High", "Normal", "Low"];
          const priority = priorityLabels[issue.priority || 0] || "No priority";

          return `${index + 1}. ${issue.identifier}: ${issue.title}\n   Status: ${state?.name || "No state"} | Priority: ${priority} | Assignee: ${assignee?.name || "Unassigned"}`;
        })
      );
      const issueText = issueList.join("\n\n");

      const resultMessage = `📋 Found ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n\n${issueText}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source,
      });

      return {
        text: `Found ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
        success: true,
        data: {
          issues: await Promise.all(
            issues.map(async (issue) => {
              const state = await issue.state;
              const assignee = await issue.assignee;
              const team = await issue.team;

              return {
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                url: issue.url,
                priority: issue.priority,
                state: state ? { name: state.name, type: state.type } : null,
                assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
                team: team ? { name: team.name, key: team.key } : null,
                createdAt:
                  issue.createdAt instanceof Date ? issue.createdAt.toISOString() : issue.createdAt,
                updatedAt:
                  issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : issue.updatedAt,
              };
            })
          ),
          filters: filters ? { ...filters } : undefined,
          count: issues.length,
        },
      };
    } catch (error) {
      logger.error("Failed to search issues:", error);
      const errorMessage = `❌ Failed to search issues: ${error instanceof Error ? error.message : "Unknown error"}`;
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
