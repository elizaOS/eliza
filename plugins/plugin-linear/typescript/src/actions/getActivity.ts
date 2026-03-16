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

export const getActivityAction: Action = {
  name: "GET_LINEAR_ACTIVITY",
  description: "Get recent Linear activity log with optional filters",
  similes: [
    "get-linear-activity",
    "show-linear-activity",
    "view-linear-activity",
    "check-linear-activity",
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

      const content = message.content.text || "";
      const filters: Record<string, unknown> = {};
      let limit = 10;

      if (content) {
        const prompt = getActivityTemplate.replace("{{userMessage}}", content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt,
        });

        if (response) {
          try {
            const parsed = JSON.parse(
              response
                .replace(/^```(?:json)?\n?/, "")
                .replace(/\n?```$/, "")
                .trim()
            );

            if (parsed.timeRange) {
              const now = new Date();
              let fromDate: Date | undefined;

              if (parsed.timeRange.from) {
                fromDate = new Date(parsed.timeRange.from);
              } else if (parsed.timeRange.period) {
                switch (parsed.timeRange.period) {
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

            if (parsed.actionTypes && parsed.actionTypes.length > 0) {
              filters.action = parsed.actionTypes[0];
            }

            if (parsed.resourceTypes && parsed.resourceTypes.length > 0) {
              filters.resource_type = parsed.resourceTypes[0];
            }

            if (parsed.resourceId) {
              filters.resource_id = parsed.resourceId;
            }

            if (parsed.successFilter && parsed.successFilter !== "all") {
              filters.success = parsed.successFilter === "success";
            }

            limit = parsed.limit || 10;
          } catch (parseError) {
            logger.warn("Failed to parse activity filters:", parseError);
          }
        }
      }

      let activity = linearService.getActivityLog(limit * 2, filters);

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
          },
        };
      }

      const activityText = activity
        .map((item, index) => {
          const time = new Date(item.timestamp).toLocaleString();
          const status = item.success ? "✅" : "❌";
          const details = Object.entries(item.details)
            .filter(([key]) => key !== "filters")
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
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
            details: JSON.stringify(item.details) as string,
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
