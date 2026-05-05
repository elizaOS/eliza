/**
 * @module actions/list-event-types
 * @description LIST_CALENDLY_EVENT_TYPES — enumerates the connected user's
 * active event types. Returns enough metadata for downstream logic (and UI)
 * to offer a booking link per type.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CalendlyService } from "../services/CalendlyService.js";
import {
  CALENDLY_SERVICE_TYPE,
  type CalendlyActionResult,
  CalendlyActions,
  type CalendlyEventType,
} from "../types.js";

function getService(runtime: IAgentRuntime): CalendlyService | null {
  return runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE);
}

export const listEventTypesAction: Action = {
  name: CalendlyActions.LIST_CALENDLY_EVENT_TYPES,
  similes: ["SHOW_CALENDLY_EVENT_TYPES", "CALENDLY_EVENT_TYPES"],
  description:
    "Lists the connected Calendly user's active event types with their scheduling URLs and durations.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = getService(runtime);
    return service?.isConnected() === true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<CalendlyActionResult<{ eventTypes: CalendlyEventType[] }>> => {
    const service = getService(runtime);
    if (!service || !service.isConnected()) {
      const error =
        "Calendly is not connected — set CALENDLY_ACCESS_TOKEN to list event types";
      await callback?.({ text: error });
      return { success: false, error };
    }
    try {
      const eventTypes = await service.listEventTypes();
      await callback?.({
        text: `Found ${eventTypes.length} active Calendly event type(s)`,
      });
      return { success: true, data: { eventTypes } };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown Calendly error";
      logger.warn(
        { error: message },
        "[Calendly:LIST_CALENDLY_EVENT_TYPES] request failed",
      );
      await callback?.({
        text: `LIST_CALENDLY_EVENT_TYPES failed: ${message}`,
      });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What Calendly event types do I have?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Found 3 active Calendly event type(s)" },
      },
    ],
  ],
};
