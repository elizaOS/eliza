/**
 * @module actions/calendly-op
 * @description CALENDLY_OP — unified router for booking and cancellation.
 *
 * Switches on `op`:
 *   - "book"   — third-party Calendly URL handoff or own-event booking link
 *   - "cancel" — cancel a scheduled event (requires confirmed:true)
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getActiveRoutingContextsForTurn, logger } from "@elizaos/core";
import {
  calendlyAccountIdParameter,
  resolveCalendlyAccountId,
} from "../accounts.js";
import type { CalendlyService } from "../services/CalendlyService.js";
import {
  CALENDLY_SERVICE_TYPE,
  type CalendlyActionResult,
  CalendlyActions,
} from "../types.js";

type BookSource = "third-party" | "own-event";
type CalendlyOp = "book" | "cancel";

interface BookData {
  bookingUrl: string;
  source: BookSource;
  [key: string]: string;
}

interface CancelData {
  uuid: string;
  reason?: string;
  [key: string]: string | boolean | undefined;
}

const CALENDLY_URL_RE = /https?:\/\/(?:www\.)?calendly\.com\/[\w\-./]+/i;
const DURATION_RE = /(\d{1,3})\s*(?:min|minute|minutes|m)\b/i;
const UUID_FROM_URI_RE =
  /scheduled_events\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const BECAUSE_RE = /\bbecause\s+(.+?)(?:[.!?]|$)/i;
const CALENDLY_CONTEXTS = ["calendar", "automation", "connectors"] as const;
const CALENDLY_KEYWORDS = [
  "calendly",
  "book",
  "booking",
  "schedule",
  "cancel",
  "meeting",
  "appointment",
  "event",
  "reservar",
  "programar",
  "cancelar",
  "reunión",
  "réserver",
  "planifier",
  "annuler",
  "buchen",
  "absagen",
  "prenotare",
  "annullare",
  "agendar",
  "预约",
  "取消",
  "予約",
  "キャンセル",
] as const;

function hasCalendlyContext(message: Memory, state?: State): boolean {
  const active = new Set(
    getActiveRoutingContextsForTurn(state, message).map((context) =>
      `${context}`.toLowerCase(),
    ),
  );
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") active.add(item.toLowerCase());
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  return CALENDLY_CONTEXTS.some((context) => active.has(context));
}

function hasCalendlyIntent(message: Memory, state?: State): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return CALENDLY_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

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

function isConfirmed(params: Record<string, unknown>): boolean {
  const raw = params.confirmed;
  return raw === true || raw === "true";
}

function readOp(params: Record<string, unknown>): CalendlyOp | null {
  const raw = params.op;
  if (raw === "book" || raw === "cancel") {
    return raw;
  }
  return null;
}

async function handleBook(
  runtime: IAgentRuntime,
  text: string,
  params: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<CalendlyActionResult<BookData>> {
  const thirdPartyUrl = extractCalendlyUrl(text);
  if (thirdPartyUrl) {
    await callback?.({ text: `Calendly booking link: ${thirdPartyUrl}` });
    return {
      success: true,
      data: { bookingUrl: thirdPartyUrl, source: "third-party" },
    };
  }

  const service = getService(runtime);
  const accountId = resolveCalendlyAccountId(runtime, params);
  if (!service?.isConnected(accountId)) {
    const error =
      "No third-party Calendly URL found and Calendly is not connected — set CALENDLY_ACCESS_TOKEN to resolve your own booking link";
    await callback?.({ text: error });
    return { success: false, error };
  }

  try {
    const bookingUrl = await service.getBookingUrl(
      {
        durationMinutes: extractDuration(params, text),
        slug: extractSlug(params),
      },
      accountId,
    );
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
      "[Calendly:CALENDLY_OP book] resolution failed",
    );
    await callback?.({ text: `CALENDLY_OP book failed: ${reason}` });
    return { success: false, error: reason };
  }
}

async function handleCancel(
  runtime: IAgentRuntime,
  text: string,
  params: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<CalendlyActionResult<CancelData>> {
  const service = getService(runtime);
  const accountId = resolveCalendlyAccountId(runtime, params);
  if (!service?.isConnected(accountId)) {
    const error =
      "Calendly is not connected — set CALENDLY_ACCESS_TOKEN to cancel bookings";
    await callback?.({ text: error });
    return { success: false, error };
  }
  const uuid = extractUuid(params, text);
  if (!uuid) {
    const error =
      "CALENDLY_OP cancel requires a scheduled_events/{uuid} URI or eventUuid option";
    await callback?.({ text: error });
    return { success: false, error };
  }
  const reason = extractReason(params, text);
  const preview = `Confirmation required before canceling Calendly event ${uuid}${reason ? ` (${reason})` : ""}.`;
  if (!isConfirmed(params)) {
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
    await service.cancelBooking(uuid, reason, accountId);
    await callback?.({
      text: `Canceled Calendly event ${uuid}${reason ? ` (${reason})` : ""}`,
    });
    return { success: true, data: { uuid, reason } };
  } catch (err) {
    const errMessage =
      err instanceof Error ? err.message : "Unknown Calendly error";
    logger.warn(
      { error: errMessage, uuid },
      "[Calendly:CALENDLY_OP cancel] request failed",
    );
    await callback?.({ text: `CALENDLY_OP cancel failed: ${errMessage}` });
    return { success: false, error: errMessage };
  }
}

export const calendlyOpAction: Action = {
  name: CalendlyActions.CALENDLY_OP,
  contexts: [...CALENDLY_CONTEXTS],
  contextGate: { anyOf: [...CALENDLY_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: [
    "BOOK_CALENDLY",
    "CALENDLY_BOOK_SLOT",
    "SCHEDULE_CALENDLY",
    "CANCEL_CALENDLY",
    "CANCEL_CALENDLY_EVENT",
  ],
  description:
    "Calendly slot operations. Set op to 'book' to hand off a third-party Calendly URL or resolve the connected user's booking link, or 'cancel' to cancel a scheduled event after confirmed:true.",
  descriptionCompressed: "Calendly slot ops: book, cancel.",
  parameters: [
    {
      name: "subaction",
      description: "Operation to perform: 'book' or 'cancel'.",
      required: true,
      schema: { type: "string" as const, enum: ["book", "cancel"] },
    },
    {
      name: "confirmed",
      description: "Required true to cancel after preview. Ignored for book.",
      required: false,
      schema: { type: "boolean" as const, default: false },
    },
    {
      name: "slug",
      description: "Calendly event-type slug for own-event booking.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "durationMinutes",
      description: "Desired own-event duration in minutes.",
      required: false,
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "eventUuid",
      description: "Scheduled event UUID for cancellation.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Optional cancellation reason.",
      required: false,
      schema: { type: "string" as const },
    },
    calendlyAccountIdParameter,
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    return (
      Boolean(runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE)) &&
      (hasCalendlyContext(message, state) || hasCalendlyIntent(message, state))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<CalendlyActionResult<BookData | CancelData>> => {
    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    const params = mergedOptions(options);
    const accountId = resolveCalendlyAccountId(runtime, params);
    const op = readOp(params);
    if (!op) {
      const error = "CALENDLY_OP requires op in {book, cancel}";
      await callback?.({ text: error });
      return { success: false, error };
    }
    if (op === "book") {
      return handleBook(runtime, text, params, callback);
    }
    return handleCancel(runtime, text, { ...params, accountId }, callback);
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
          actions: ["CALENDLY"],
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
          actions: ["CALENDLY"],
        },
      },
    ],
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
          actions: ["CALENDLY"],
        },
      },
    ],
  ],
};
