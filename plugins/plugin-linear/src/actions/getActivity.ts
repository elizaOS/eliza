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
import { getActivityTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";
import { getLinearAccountId, linearAccountIdParameter } from "./account-options";
import {
  getNumberValue,
  getRecordValue,
  getStringArrayValue,
  getStringValue,
  parseLinearPromptResponse,
} from "./parseLinearPrompt.js";
import { validateLinearActionIntent } from "./validate-linear-intent";

function formatActivityDetail(value: unknown): string {
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    return value.map(formatActivityDetail).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => `${key}=${formatActivityDetail(nestedValue)}`)
      .join("; ");
  }
  return String(value);
}

type ActivityParams = {
  filters?: Record<string, unknown>;
  limit?: number;
};

export const getActivityAction: Action = {
  name: "GET_LINEAR_ACTIVITY",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description: "Get recent Linear activity log with optional filters",
  descriptionCompressed: "get recent Linear activity log w/ optional filter",
  similes: [
    "get-linear-activity",
    "show-linear-activity",
    "view-linear-activity",
    "check-linear-activity",
  ],
  parameters: [
    {
      name: "filters",
      description:
        "Optional activity filters, e.g. fromDate ISO timestamp, action, resource_type, resource_id, or success.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "limit",
      description: "Maximum number of activity log entries to return.",
      required: false,
      schema: { type: "number" as const },
    },
    linearAccountIdParameter,
  ],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Show me recent Linear activity",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll show you the recent Linear activity.",
          actions: ["GET_LINEAR_ACTIVITY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "What happened in Linear today?",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "Let me check today's Linear activity for you.",
          actions: ["GET_LINEAR_ACTIVITY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Show me what issues John created this week",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll find the issues John created this week.",
          actions: ["GET_LINEAR_ACTIVITY"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state, {
      keywords: ["get", "linear", "activity"],
      regexAlternation: "get|linear|activity",
    }),

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
      const accountId = getLinearAccountId(runtime, _options);

      const content = message.content.text || "";
      const params = (_options?.parameters ?? {}) as ActivityParams;
      const filters: Record<string, unknown> = { ...(params.filters ?? {}) };
      let limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 10;

      if (content) {
        const prompt = getActivityTemplate.replace("{{userMessage}}", content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt,
        });

        if (response) {
          try {
            const parsed = parseLinearPromptResponse(response);
            if (Object.keys(parsed).length === 0) {
              throw new Error("No fields found in model response");
            }

            const timeRange = getRecordValue(parsed.timeRange);
            if (timeRange) {
              const now = new Date();
              let fromDate: Date | undefined;

              const from = getStringValue(timeRange.from);
              const period = getStringValue(timeRange.period);
              if (from) {
                fromDate = new Date(from);
              } else if (period) {
                switch (period) {
                  case "today":
                    fromDate = new Date(now.setHours(0, 0, 0, 0));
                    break;
                  case "yesterday":
                    fromDate = new Date(now.setDate(now.getDate() - 1));
                    fromDate.setHours(0, 0, 0, 0);
                    break;
                  case "this-week":
                    fromDate = new Date(now.setDate(now.getDate() - now.getDay()));
                    fromDate.setHours(0, 0, 0, 0);
                    break;
                  case "last-week":
                    fromDate = new Date(now.setDate(now.getDate() - now.getDay() - 7));
                    fromDate.setHours(0, 0, 0, 0);
                    break;
                  case "this-month":
                    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    break;
                }
              }

              if (fromDate) {
                filters.fromDate = fromDate.toISOString();
              }
            }

            const actionTypes = getStringArrayValue(parsed.actionTypes);
            if (actionTypes && actionTypes.length > 0) {
              filters.action = actionTypes[0];
            }

            const resourceTypes = getStringArrayValue(parsed.resourceTypes);
            if (resourceTypes && resourceTypes.length > 0) {
              filters.resource_type = resourceTypes[0];
            }

            const resourceId = getStringValue(parsed.resourceId);
            if (resourceId) {
              filters.resource_id = resourceId;
            }

            const successFilter = getStringValue(parsed.successFilter);
            if (successFilter && successFilter !== "all") {
              filters.success = successFilter === "success";
            }

            limit = getNumberValue(parsed.limit) || 10;
          } catch (parseError) {
            logger.warn("Failed to parse activity filters:", parseError);
          }
        }
      }

      let activity = linearService.getActivityLog(limit * 2, filters, accountId);

      if (filters.fromDate) {
        const fromDateValue = filters.fromDate;
        const fromDate =
          typeof fromDateValue === "string"
            ? fromDateValue
            : fromDateValue instanceof Date
              ? fromDateValue.toISOString()
              : String(fromDateValue);
        const fromTime = new Date(fromDate).getTime();
        if (!Number.isNaN(fromTime)) {
          activity = activity.filter((item) => new Date(item.timestamp).getTime() >= fromTime);
        }
      }

      activity = activity.slice(0, limit);

      if (activity.length === 0) {
        const noActivityMessage = filters.fromDate
          ? `No Linear activity found for the specified filters.`
          : "No recent Linear activity found.";
        await callback?.({
          text: noActivityMessage,
          source: message.content.source,
        });
        return {
          text: noActivityMessage,
          success: true,
          data: {
            activity: [],
            accountId,
          },
        };
      }

      const activityText = activity
        .map((item, index) => {
          const time = new Date(item.timestamp).toLocaleString();
          const status = item.success ? "✅" : "❌";
          const details = Object.entries(item.details)
            .filter(([key]) => key !== "filters")
            .map(([key, value]) => `${key}: ${formatActivityDetail(value)}`)
            .join(", ");

          return `${index + 1}. ${status} ${item.action} on ${item.resource_type} ${item.resource_id}\n   Time: ${time}\n   ${details ? `Details: ${details}` : ""}${item.error ? `\n   Error: ${item.error}` : ""}`;
        })
        .join("\n\n");

      const headerText = filters.fromDate
        ? `📊 Linear activity ${content}:`
        : "📊 Recent Linear activity:";

      const resultMessage = `${headerText}\n\n${activityText}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source,
      });

      return {
        text: `Found ${activity.length} activity item${activity.length === 1 ? "" : "s"}`,
        success: true,
        data: {
          activity: activity.map((item) => ({
            id: item.id,
            action: item.action,
            resource_type: item.resource_type,
            resource_id: item.resource_id,
            success: item.success,
            error: item.error,
            details: formatActivityDetail(item.details),
            timestamp:
              typeof item.timestamp === "string"
                ? item.timestamp
                : new Date(item.timestamp).toISOString(),
          })) as Array<Record<string, string | boolean | undefined>>,
          filters: filters
            ? {
                ...filters,
                fromDate: filters.fromDate
                  ? typeof filters.fromDate === "string"
                    ? filters.fromDate
                    : String(filters.fromDate)
                  : undefined,
              }
            : undefined,
          count: activity.length,
          accountId,
        },
      };
    } catch (error) {
      logger.error("Failed to get activity:", error);
      const errorMessage = `❌ Failed to get activity: ${error instanceof Error ? error.message : "Unknown error"}`;
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
