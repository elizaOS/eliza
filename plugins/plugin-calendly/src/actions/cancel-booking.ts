/**
 * @module actions/cancel-booking
 * @description CANCEL_CALENDLY_BOOKING — cancels a scheduled Calendly event.
 *
 * The scheduled-event URI is the canonical handle. Callers may pass either:
 *  - a raw UUID via `options.eventUuid`,
 *  - a full URI via `options.eventUri` (…/scheduled_events/{uuid}),
 *  - or a message containing `scheduled_events/{uuid}` (or a URI).
 *
 * Optional reason is extracted from `options.reason` or a "because <reason>"
 * suffix in the message text.
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
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
} from "../types.js";

const UUID_FROM_URI_RE =
  /scheduled_events\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const BECAUSE_RE = /\bbecause\s+(.+?)(?:[.!?]|$)/i;

function extractUuid(
  options: Record<string, unknown> | undefined,
  text: string,
): string | null {
  const directUuid = options?.eventUuid;
  if (typeof directUuid === "string" && directUuid.length > 0) {
    return directUuid;
  }
  const uri = options?.eventUri;
  if (typeof uri === "string") {
    const match = UUID_FROM_URI_RE.exec(uri);
    if (match) {
      return match[1];
    }
  }
  const fromText = UUID_FROM_URI_RE.exec(text);
  if (fromText) {
    return fromText[1];
  }
  return null;
}

function extractReason(
  options: Record<string, unknown> | undefined,
  text: string,
): string | undefined {
  const raw = options?.reason;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  const safeText = text.length > 10_000 ? text.slice(0, 10_000) : text;
  const match = BECAUSE_RE.exec(safeText);
  if (match) {
    return match[1].trim();
  }
  return undefined;
}

function getService(runtime: IAgentRuntime): CalendlyService | null {
  return runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE);
}

function mergedOptions(options?: HandlerOptions): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function isConfirmed(options?: HandlerOptions): boolean {
  const raw = mergedOptions(options).confirmed;
  return raw === true || raw === "true";
}

export const cancelBookingAction: Action = {
  name: CalendlyActions.CANCEL_CALENDLY_BOOKING,
  similes: ["CANCEL_CALENDLY", "CANCEL_CALENDLY_EVENT"],
  description:
    "Cancels a scheduled Calendly event after confirmed:true. Extracts the scheduled_events/{uuid} handle and an optional 'because <reason>' suffix from the message.",
  parameters: [
    {
      name: "confirmed",
      description:
        "Must be true to cancel the Calendly event after preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    return getService(runtime)?.isConnected() === true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<CalendlyActionResult<{ uuid: string; reason?: string }>> => {
    const service = getService(runtime);
    if (!service || !service.isConnected()) {
      const error =
        "Calendly is not connected — set CALENDLY_ACCESS_TOKEN to cancel bookings";
      await callback?.({ text: error });
      return { success: false, error };
    }
    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    const params = mergedOptions(options);
    const uuid = extractUuid(params, text);
    if (!uuid) {
      const error =
        "CANCEL_CALENDLY_BOOKING requires a scheduled_events/{uuid} URI or eventUuid option";
      await callback?.({ text: error });
      return { success: false, error };
    }
    const reason = extractReason(params, text);
    const preview = `Confirmation required before canceling Calendly event ${uuid}${reason ? ` (${reason})` : ""}.`;
    if (!isConfirmed(options)) {
      await callback?.({ text: preview });
      return {
        success: false,
        requiresConfirmation: true,
        preview,
        text: preview,
        data: { requiresConfirmation: true, preview, uuid, reason },
      };
    }
    try {
      await service.cancelBooking(uuid, reason);
      await callback?.({
        text: `Canceled Calendly event ${uuid}${reason ? ` (${reason})` : ""}`,
      });
      return { success: true, data: { uuid, reason } };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown Calendly error";
      logger.warn(
        { error: message, uuid },
        "[Calendly:CANCEL_CALENDLY_BOOKING] request failed",
      );
      await callback?.({ text: `CANCEL_CALENDLY_BOOKING failed: ${message}` });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Cancel scheduled_events/11111111-2222-3333-4444-555555555555 because I need to travel",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Canceled Calendly event 11111111-2222-3333-4444-555555555555 (I need to travel)",
        },
      },
    ],
  ],
};
