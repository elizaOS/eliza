import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { LinearService } from "../services/linear";
import type { LinearActivityItem } from "../types";

export const linearActivityProvider: Provider = {
  name: "LINEAR_ACTIVITY",
  description: "Provides context about recent Linear activity",
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
            details: JSON.stringify(item.details) as string,
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
