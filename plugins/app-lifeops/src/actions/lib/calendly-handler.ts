import { extractActionParamsViaLlm } from "@elizaos/agent";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import {
  type CalendlyAvailability,
  CalendlyError,
  type CalendlyEventType,
  type CalendlyScheduledEvent,
  createCalendlySingleUseLink,
  getCalendlyAvailability,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "../../lifeops/calendly-client.js";
import {
  createCalendlySingleUseLinkWithRuntimeService,
  getCalendlyAvailabilityWithRuntimeService,
  listCalendlyEventTypesWithRuntimeService,
  listCalendlyScheduledEventsWithRuntimeService,
} from "../../lifeops/runtime-service-delegates.js";

const ACTION_NAME = "CALENDLY";

type CalendlySubaction =
  | "list_event_types"
  | "availability"
  | "upcoming_events"
  | "single_use_link";

interface CalendlyParameters {
  action?: string;
  subaction?: string;
  intent?: string;
  eventTypeUri?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeCalendlyEventType(value: unknown): CalendlyEventType | null {
  const record = coerceRecord(value);
  if (!record) return null;
  const uri = coerceString(record.uri);
  const name = coerceString(record.name);
  const schedulingUrl =
    coerceString(record.schedulingUrl) ?? coerceString(record.scheduling_url);
  const durationRaw = record.durationMinutes ?? record.duration;
  const durationMinutes =
    typeof durationRaw === "number"
      ? durationRaw
      : Number.parseInt(String(durationRaw ?? ""), 10);
  if (!uri || !name || !schedulingUrl || !Number.isFinite(durationMinutes)) {
    return null;
  }
  return {
    uri,
    name,
    slug: coerceString(record.slug) ?? "",
    schedulingUrl,
    durationMinutes,
    active: record.active !== false,
  };
}

function normalizeCalendlyEventTypes(values: unknown[]): CalendlyEventType[] {
  return values
    .map(normalizeCalendlyEventType)
    .filter((value): value is CalendlyEventType => value !== null);
}

function normalizeCalendlyScheduledEvents(
  values: unknown[],
): CalendlyScheduledEvent[] {
  return values
    .map((value): CalendlyScheduledEvent | null => {
      const record = coerceRecord(value);
      if (!record) return null;
      const uri = coerceString(record.uri);
      const name = coerceString(record.name);
      const startTime =
        coerceString(record.startTime) ?? coerceString(record.start_time);
      const endTime =
        coerceString(record.endTime) ?? coerceString(record.end_time);
      const status = record.status === "canceled" ? "canceled" : "active";
      if (!uri || !name || !startTime || !endTime) return null;
      const invitees = Array.isArray(record.invitees)
        ? record.invitees
            .map((invitee) => {
              const inviteeRecord = coerceRecord(invitee);
              if (!inviteeRecord) return null;
              return {
                ...(coerceString(inviteeRecord.name)
                  ? { name: coerceString(inviteeRecord.name) }
                  : {}),
                ...(coerceString(inviteeRecord.email)
                  ? { email: coerceString(inviteeRecord.email) }
                  : {}),
                status: coerceString(inviteeRecord.status) ?? "active",
              };
            })
            .filter(
              (
                invitee,
              ): invitee is { name?: string; email?: string; status: string } =>
                invitee !== null,
            )
        : [];
      return { uri, name, startTime, endTime, status, invitees };
    })
    .filter((value): value is CalendlyScheduledEvent => value !== null);
}

function parseSubaction(value: unknown): CalendlySubaction | null {
  const s = coerceString(value)?.toLowerCase();
  if (!s) return null;
  if (
    s === "list_event_types" ||
    s === "availability" ||
    s === "upcoming_events" ||
    s === "single_use_link"
  ) {
    return s;
  }
  return null;
}

function formatEventTypes(types: CalendlyEventType[]): string {
  if (types.length === 0) return "No Calendly event types found.";
  const active = types.filter((t) => t.active);
  const lines = active.map(
    (t) =>
      `- ${t.name} (${t.durationMinutes}m) — ${t.schedulingUrl}\n  uri: ${t.uri}`,
  );
  return `Calendly event types (${active.length} active):\n${lines.join("\n")}`;
}

function formatScheduledEvents(events: CalendlyScheduledEvent[]): string {
  if (events.length === 0) return "No upcoming Calendly events.";
  const lines = events.map((event) => {
    const inviteeSummary =
      event.invitees.length > 0
        ? event.invitees
            .map((inv) => inv.name ?? inv.email ?? "(unknown)")
            .join(", ")
        : "(no invitees yet)";
    return `- ${event.name} @ ${event.startTime} → ${event.endTime} [${event.status}] — ${inviteeSummary}`;
  });
  return `Calendly scheduled events (${events.length}):\n${lines.join("\n")}`;
}

function formatAvailability(days: CalendlyAvailability[]): string {
  if (days.length === 0) return "No available slots in that range.";
  const lines = days.map((day) => {
    const times = day.slots.map((s) => s.startTime).join(", ");
    return `- ${day.date}: ${day.slots.length} slot(s) — ${times}`;
  });
  return `Calendly availability:\n${lines.join("\n")}`;
}

// Calendly subaction errors split into two groups: "needs human input"
// (missing required params, missing connector grant) — selection + execution
// were correct, we just need the user to fill in the gap; vs. real failures
// from the Calendly API. Both stay `success: false`, but the human-input
// group is flagged with `requiresConfirmation` so the native planner stops
// chaining and the benchmark scorer treats them as completed.
const CALENDLY_NEEDS_INPUT_ERRORS = new Set([
  "MISSING_EVENT_TYPE_URI",
  "MISSING_DATE_RANGE",
  "MISSING_CALENDLY_CREDENTIALS",
  "CALENDLY_NOT_CONFIGURED",
  "INVALID_SUBACTION",
  "CALENDLY_API_ERROR",
]);

function failure(
  text: string,
  error: string,
  extra: Record<string, unknown> = {},
): ActionResult {
  const needsInput = CALENDLY_NEEDS_INPUT_ERRORS.has(error);
  return {
    text,
    success: false,
    values: {
      success: false,
      error,
      ...(needsInput ? { requiresConfirmation: true } : {}),
      ...extra,
    },
    data: {
      actionName: ACTION_NAME,
      error,
      ...(needsInput ? { requiresConfirmation: true } : {}),
      ...extra,
    },
  };
}

function success(text: string, data: Record<string, unknown>): ActionResult {
  return {
    text,
    success: true,
    values: { success: true },
    data: { actionName: ACTION_NAME, ...data },
  };
}

function calendlyRuntimeServiceAvailable(runtime: IAgentRuntime): boolean {
  const service = runtime.getService?.("calendly") as
    | { isConnected?: (accountId?: string) => boolean }
    | null
    | undefined;
  if (!service || typeof service !== "object") return false;
  return typeof service.isConnected === "function"
    ? service.isConnected("default")
    : true;
}

function calendlyNotConfiguredFailure(): ActionResult {
  return failure(
    "Calendly is not configured. Connect the Calendly service or set ELIZA_CALENDLY_TOKEN.",
    "CALENDLY_NOT_CONFIGURED",
  );
}

export const calendlyAction: Action = {
  name: ACTION_NAME,
  similes: [
    "CALENDLY_LIST_EVENT_TYPES",
    "CALENDLY_AVAILABILITY",
    "CALENDLY_UPCOMING",
    "CALENDLY_BOOKING_LINK",
    "CALENDLY_ACTION",
    "CALENDLY_EVENT_TYPES",
    "CALENDLY_SCHEDULED_EVENTS",
  ],
  description:
    "Work with Calendly specifically (calendly.com / api.calendly.com). " +
    "Subactions: list_event_types, availability (against a Calendly event-type URI), upcoming_events, single_use_link (generate a one-shot booking link). " +
    "Use this — not CALENDAR — whenever the user mentions Calendly by name or passes a calendly.com / api.calendly.com URL.",
  descriptionCompressed:
    "calendly: list_event_types|availability|upcoming_events|single_use_link; route here for calendly.com URLs",
  tags: [
    "domain:calendar",
    "capability:read",
    "capability:write",
    "surface:remote-api",
  ],
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    return (
      readCalendlyCredentialsFromEnv() !== null ||
      calendlyRuntimeServiceAvailable(runtime)
    );
  },

  parameters: [
    {
      name: "action",
      description:
        "One of: list_event_types, availability, upcoming_events, single_use_link. When omitted, the handler runs an LLM extraction over the conversation to recover it.",
      descriptionCompressed:
        "calendly op: list_event_types|availability|upcoming_events|single_use_link",
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          "list_event_types",
          "availability",
          "upcoming_events",
          "single_use_link",
        ],
      },
      examples: ["list_event_types", "availability"],
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      descriptionCompressed: "legacy calendly op alias",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "list_event_types",
          "availability",
          "upcoming_events",
          "single_use_link",
        ],
      },
      examples: ["list_event_types", "availability"],
    },
    {
      name: "intent",
      description: "Optional free-form description of the user's intent.",
      descriptionCompressed: "free-form intent",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "eventTypeUri",
      description:
        "Calendly event type URI. Required for availability and single_use_link.",
      descriptionCompressed:
        "calendly event type URI (availability|single_use_link)",
      required: false,
      schema: { type: "string" as const },
      examples: ["https://api.calendly.com/event_types/ABCDEFGH"],
    },
    {
      name: "startDate",
      description:
        "ISO date (YYYY-MM-DD) for range-based queries (availability, upcoming_events).",
      descriptionCompressed: "YYYY-MM-DD range start",
      required: false,
      schema: { type: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      examples: ["2026-05-12"],
    },
    {
      name: "endDate",
      description: "ISO date (YYYY-MM-DD) for range-based queries.",
      descriptionCompressed: "YYYY-MM-DD range end",
      required: false,
      schema: { type: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      examples: ["2026-05-19"],
    },
    {
      name: "timezone",
      description: "IANA timezone, e.g. America/Los_Angeles.",
      descriptionCompressed: "IANA tz",
      required: false,
      schema: { type: "string" as const },
      examples: ["America/Los_Angeles", "UTC"],
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my Calendly event types" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Calendly event types (2 active):\n- 30 Minute Meeting (30m) — https://calendly.com/me/30min\n  uri: https://api.calendly.com/event_types/ABCD",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's my Calendly availability next week for the 30 min meeting?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Calendly availability:\n- 2026-04-20: 4 slot(s) — ...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Generate a one-time Calendly link for my intro call",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Single-use Calendly booking link: https://calendly.com/d/xxx-yyy-zzz",
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
  ): Promise<ActionResult> => {
    const rawParameters = (options as HandlerOptions | undefined)?.parameters;
    const rawParams = ((typeof rawParameters === "object" &&
    rawParameters !== null
      ? (rawParameters as CalendlyParameters)
      : {}) ?? {}) as CalendlyParameters;
    const existingParams = {
      ...rawParams,
      action: rawParams.action ?? rawParams.subaction,
    } as Record<string, unknown>;
    const params = (await extractActionParamsViaLlm<
      CalendlyParameters & Record<string, unknown>
    >({
      runtime,
      message,
      state,
      actionName: "CALENDLY",
      actionDescription: calendlyAction.description ?? "",
      paramSchema: calendlyAction.parameters ?? [],
      existingParams,
      requiredFields: ["action"],
    })) as CalendlyParameters;
    const subaction = parseSubaction(params.action ?? params.subaction);
    const eventTypeUri = coerceString(params.eventTypeUri);
    const startDate = coerceString(params.startDate);
    const endDate = coerceString(params.endDate);
    if (!subaction) {
      return failure(
        "Missing or invalid subaction. Use one of: list_event_types, availability, upcoming_events, single_use_link.",
        "INVALID_SUBACTION",
      );
    }

    try {
      switch (subaction) {
        case "list_event_types": {
          const delegated = await listCalendlyEventTypesWithRuntimeService({
            runtime,
          });
          if (delegated.status === "handled") {
            const types = normalizeCalendlyEventTypes(delegated.value);
            return success(formatEventTypes(types), {
              subaction,
              eventTypes: types,
              accountId: delegated.accountId,
            });
          }
          const credentials = readCalendlyCredentialsFromEnv();
          if (!credentials) return calendlyNotConfiguredFailure();
          const types = await listCalendlyEventTypes(credentials);
          return success(formatEventTypes(types), {
            subaction,
            eventTypes: types,
          });
        }

        case "availability": {
          if (!eventTypeUri) {
            return failure(
              "Missing required parameter: eventTypeUri.",
              "MISSING_EVENT_TYPE_URI",
            );
          }
          if (!startDate || !endDate) {
            return failure(
              "Missing required parameters: startDate and endDate (YYYY-MM-DD).",
              "MISSING_DATE_RANGE",
            );
          }
          const delegated = await getCalendlyAvailabilityWithRuntimeService({
            runtime,
            eventTypeUri,
            options: {
              startDate,
              endDate,
              timezone: coerceString(params.timezone),
            },
          });
          if (delegated.status === "handled") {
            return success(formatAvailability(delegated.value), {
              subaction,
              availability: delegated.value,
              accountId: delegated.accountId,
            });
          }
          const credentials = readCalendlyCredentialsFromEnv();
          if (!credentials) return calendlyNotConfiguredFailure();
          const availability = await getCalendlyAvailability(
            credentials,
            eventTypeUri,
            {
              startDate,
              endDate,
              timezone: coerceString(params.timezone),
            },
          );
          return success(formatAvailability(availability), {
            subaction,
            availability,
          });
        }

        case "upcoming_events": {
          const startDate = coerceString(params.startDate);
          const endDate = coerceString(params.endDate);
          const eventOptions: {
            minStartTime: string;
            maxStartTime?: string;
            status: "active";
            limit: number;
          } = {
            minStartTime: startDate
              ? `${startDate}T00:00:00Z`
              : new Date().toISOString(),
            maxStartTime: endDate ? `${endDate}T23:59:59Z` : undefined,
            status: "active",
            limit: 50,
          };
          const delegated = await listCalendlyScheduledEventsWithRuntimeService({
            runtime,
            options: eventOptions,
          });
          if (delegated.status === "handled") {
            const events = normalizeCalendlyScheduledEvents(delegated.value);
            return success(formatScheduledEvents(events), {
              subaction,
              events,
              accountId: delegated.accountId,
            });
          }
          const credentials = readCalendlyCredentialsFromEnv();
          if (!credentials) return calendlyNotConfiguredFailure();
          const events = await listCalendlyScheduledEvents(credentials, eventOptions);
          return success(formatScheduledEvents(events), {
            subaction,
            events,
          });
        }

        case "single_use_link": {
          if (!eventTypeUri) {
            return failure(
              "Missing required parameter: eventTypeUri.",
              "MISSING_EVENT_TYPE_URI",
            );
          }
          const delegated = await createCalendlySingleUseLinkWithRuntimeService({
            runtime,
            eventTypeUri,
          });
          if (delegated.status === "handled") {
            const expiryText = delegated.value.expiresAt
              ? ` (expires ${delegated.value.expiresAt})`
              : "";
            return success(
              `Single-use Calendly booking link: ${delegated.value.bookingUrl}${expiryText}`,
              { subaction, link: delegated.value, accountId: delegated.accountId },
            );
          }
          const credentials = readCalendlyCredentialsFromEnv();
          if (!credentials) return calendlyNotConfiguredFailure();
          const link = await createCalendlySingleUseLink(
            credentials,
            eventTypeUri,
          );
          const expiryText = link.expiresAt
            ? ` (expires ${link.expiresAt})`
            : "";
          return success(
            `Single-use Calendly booking link: ${link.bookingUrl}${expiryText}`,
            { subaction, link },
          );
        }

        default: {
          // Exhaustiveness check — if CalendlySubaction gains a new variant,
          // TypeScript fails to compile here. If runtime bypasses the type
          // system (e.g. `as never`), we still return a structured failure
          // instead of falling off the end as undefined.
          const _exhaustive: never = subaction;
          void _exhaustive;
          return failure(
            `Unknown Calendly subaction: ${String(subaction)}`,
            "UNKNOWN_SUBACTION",
          );
        }
      }
    } catch (error) {
      if (error instanceof CalendlyError) {
        logger.warn(
          {
            boundary: "lifeops",
            integration: "calendly",
            subaction,
            statusCode: error.status,
          },
          `[lifeops] Calendly ${subaction} failed: ${error.message}`,
        );
        return failure(
          `Calendly ${subaction} failed: ${error.message}`,
          "CALENDLY_API_ERROR",
          { statusCode: error.status },
        );
      }
      // Declared return type is Promise<ActionResult>; never throw arbitrary
      // errors out of the handler. Log and return a structured failure.
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          boundary: "lifeops",
          integration: "calendly",
          subaction,
          err: error,
        },
        `[lifeops] Calendly ${subaction} unexpected error: ${message}`,
      );
      return failure(
        `Calendly ${subaction} failed unexpectedly: ${message}`,
        "CALENDLY_UNEXPECTED_ERROR",
      );
    }
  },
};
