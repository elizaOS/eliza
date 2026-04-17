/**
 * T8a — COMPUTE_TRAVEL_BUFFER action.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { LifeOpsService } from "../lifeops/service.js";
import {
  TravelTimeService,
  type CalendarEventLookupLike,
} from "./service.js";

type ComputeTravelBufferParams = {
  eventId?: string;
  originAddress?: string;
};

export const computeTravelBufferAction: Action = {
  name: "COMPUTE_TRAVEL_BUFFER",
  similes: [
    "TRAVEL_TIME",
    "COMPUTE_TRAVEL_TIME",
    "BLOCK_TRAVEL_TIME",
    "ESTIMATE_TRAVEL",
  ],
  description:
    "Compute a travel-time buffer (in minutes) for an upcoming calendar event using Google Maps Distance Matrix. Returns an explicit fallback result when GOOGLE_MAPS_API_KEY is absent or the call fails.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as ComputeTravelBufferParams;
    const eventId = params.eventId?.trim();
    if (!eventId) {
      return {
        text: "COMPUTE_TRAVEL_BUFFER requires eventId.",
        success: false,
        values: { success: false, error: "MISSING_EVENT_ID" },
        data: { actionName: "COMPUTE_TRAVEL_BUFFER" },
      };
    }
    const lifeOps = new LifeOpsService(runtime);
    const calendar: CalendarEventLookupLike = {
      getCalendarFeed: lifeOps.getCalendarFeed.bind(lifeOps),
    };
    const service = new TravelTimeService(runtime, { calendar });
    const result = await service.computeBuffer({
      eventId,
      originAddress: params.originAddress,
    });
    const text =
      result.method === "maps-api"
        ? `Travel buffer ${result.bufferMinutes} min (Maps API) — ${result.originAddress} → ${result.destinationAddress}`
        : `Travel buffer ${result.bufferMinutes} min (fixed fallback: ${result.reason})`;
    return {
      text,
      success: true,
      values: {
        success: true,
        bufferMinutes: result.bufferMinutes,
        method: result.method,
      },
      data: { actionName: "COMPUTE_TRAVEL_BUFFER", result },
    };
  },
  parameters: [
    {
      name: "eventId",
      description: "Calendar event id whose location is the destination.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "originAddress",
      description:
        "Optional starting address. When omitted, the service attempts to use a default origin or falls back to a fixed buffer.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How much travel time should I block for evt-42?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Travel buffer 24 min (Maps API) — 100 Main St → Tartine",
          action: "COMPUTE_TRAVEL_BUFFER",
        },
      },
    ],
  ] as ActionExample[][],
};
