import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { LinearService } from "../services/linear";
import type { LinearActivityItem } from "../types";

function formatDetails(details: unknown): string {
  if (details === null || details === undefined) {
    return "none";
  }
  if (Array.isArray(details)) {
    return details.map(formatDetails).join(", ");
  }
  if (typeof details !== "object") {
    return String(details);
  }
  return Object.entries(details as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${formatDetails(value)}`)
    .join("; ");
}

export const linearActivityProvider: Provider = {
  name: "LINEAR_ACTIVITY",
  description: "Provides context about recent Linear activity",
  descriptionCompressed: "provide context recent Linear activity",
  dynamic: true,
  contexts: ["automation", "connectors"],
  contextGate: { anyOf: ["automation", "connectors"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        return {
          text: "Linear service is not available",
        };
      }

      const activity = linearService.getActivityLog(10);

      if (activity.length === 0) {
        return {
          text: "No recent Linear activity",
        };
      }

      const activityList = activity.map((item: LinearActivityItem) => {
        const status = item.success ? "✓" : "✗";
        const time = new Date(item.timestamp).toLocaleTimeString();
        return `${status} ${time}: ${item.action} ${item.resource_type} ${item.resource_id}`;
      });

      const text = `Recent Linear Activity:\n${activityList.join("\n")}`;

      return {
        text,
        data: {
          activity: activity.slice(0, 10).map((item) => ({
            id: item.id,
            action: item.action,
            resource_type: item.resource_type,
            resource_id: item.resource_id,
            success: item.success,
            error: item.error,
            details: formatDetails(item.details),
            timestamp:
              typeof item.timestamp === "string"
                ? item.timestamp
                : new Date(item.timestamp).toISOString(),
          })) as Array<Record<string, string | boolean | undefined>>,
        },
      };
    } catch (_error) {
      return {
        text: "Error retrieving Linear activity",
      };
    }
  },
};
