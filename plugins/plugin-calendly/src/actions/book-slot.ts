/**
 * @module actions/book-slot
 * @description BOOK_CALENDLY_SLOT handles two distinct cases:
 *
 *   1. Third-party passthrough — the user pastes someone else's Calendly URL
 *      ("book me on https://calendly.com/alex/intro"). We cannot book on their
 *      behalf from the REST API; we echo the link back so the agent can hand
 *      it off to the user (or a browser-automation skill).
 *
 *   2. Own-event resolution — no URL is present, so we look up the connected
 *      user's event types and pick one. A `durationMinutes` hint narrows the
 *      choice; otherwise the first active event type wins, and if there are
 *      none we fall back to the user-level scheduling URL.
 *
 * These two paths are kept side by side because they share one trigger
 * ("book a Calendly slot") but the resolution mechanism differs entirely.
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
} from "../types.js";

type BookSource = "third-party" | "own-event";

/**
 * Result shape returned by the handler. The `[key: string]: string` index
 * signature is required by `ActionResult.data: ProviderDataRecord`, which is
 * itself an indexed record. Both real fields are strings.
 */
interface BookResult {
  bookingUrl: string;
  source: BookSource;
  [key: string]: string;
}

const CALENDLY_URL_RE = /https?:\/\/(?:www\.)?calendly\.com\/[\w\-./]+/i;
const DURATION_RE = /(\d{1,3})\s*(?:min|minute|minutes|m)\b/i;

function extractCalendlyUrl(text: string): string | null {
  const match = CALENDLY_URL_RE.exec(text);
  return match ? match[0] : null;
}

function extractDuration(
  options: Record<string, unknown> | undefined,
  text: string,
): number | undefined {
  const raw = options?.durationMinutes;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  const match = DURATION_RE.exec(text);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  return undefined;
}

function extractSlug(
  options: Record<string, unknown> | undefined,
): string | undefined {
  const raw = options?.slug;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function getService(runtime: IAgentRuntime): CalendlyService | null {
  return runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE);
}

export const bookSlotAction: Action = {
  name: CalendlyActions.BOOK_CALENDLY_SLOT,
  similes: ["BOOK_CALENDLY", "CALENDLY_BOOK_SLOT", "SCHEDULE_CALENDLY"],
  description:
    "Books a Calendly slot. If the message contains a third-party Calendly URL, the URL is echoed back for handoff. Otherwise resolves a booking link for one of the connected user's event types.",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    // Both paths are always eligible: third-party URLs need no auth, and
    // the own-event path reports a clean not-connected error in-handler.
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<CalendlyActionResult<BookResult>> => {
    const text =
      typeof message.content?.text === "string" ? message.content.text : "";

    const thirdPartyUrl = extractCalendlyUrl(text);
    if (thirdPartyUrl) {
      await callback?.({
        text: `Calendly booking link: ${thirdPartyUrl}`,
      });
      return {
        success: true,
        data: { bookingUrl: thirdPartyUrl, source: "third-party" },
      };
    }

    const service = getService(runtime);
    if (!service || !service.isConnected()) {
      const error =
        "No third-party Calendly URL found and Calendly is not connected — set CALENDLY_ACCESS_TOKEN to resolve your own booking link";
      await callback?.({ text: error });
      return { success: false, error };
    }

    try {
      const bookingUrl = await service.getBookingUrl({
        durationMinutes: extractDuration(options, text),
        slug: extractSlug(options),
      });
      if (!bookingUrl) {
        const error = "No active Calendly event types are available to book";
        await callback?.({ text: error });
        return { success: false, error };
      }
      await callback?.({ text: `Calendly booking link: ${bookingUrl}` });
      return {
        success: true,
        data: { bookingUrl, source: "own-event" },
      };
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "Unknown Calendly error";
      logger.warn(
        { error: reason },
        "[Calendly:BOOK_CALENDLY_SLOT] resolution failed",
      );
      await callback?.({ text: `BOOK_CALENDLY_SLOT failed: ${reason}` });
      return { success: false, error: reason };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Book me an intro call on Alex's Calendly: https://calendly.com/alex/intro",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Calendly booking link: https://calendly.com/alex/intro",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Give me a 30 minute booking link" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Calendly booking link: https://calendly.com/me/30min",
        },
      },
    ],
  ],
};
