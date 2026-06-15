import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * CALENDAR owner-facing umbrella action — STUB.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts)
 *
 * The full implementation (read feed, create/update/delete events, find slots,
 * travel buffers, conflict-on-create) will be ported here in a follow-up pass.
 * For now this file exists so the plugin registers the action contract; every
 * sub-op returns a `scaffold_stub` failure that points at the lifeops source.
 *
 * The existing in-repo `createCalendarActionRunner` (in `./calendar-handler.ts`)
 * remains the lower-level runner used by `plugin-lifeops` while migration is
 * still in flight — this new top-level action is the registration shell that
 * the calendar plugin will own end-to-end.
 */

const CALENDAR_OPS = [
  "read_feed",
  "create_event",
  "update_event",
  "delete_event",
  "find_slots",
  "next_event",
  "describe_event",
  "travel_buffer",
] as const;

type CalendarOp = (typeof CALENDAR_OPS)[number];

interface CalendarActionParameters {
  op?: unknown;
  action?: unknown;
  eventId?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  timeZone?: unknown;
  title?: unknown;
  query?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function failure(reason: string, message: string): ActionResult {
  const text = `[CALENDAR scaffold_stub] ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

export const calendarAction: Action = {
  name: "CALENDAR",
  similes: [
    "READ_CALENDAR",
    "GET_CALENDAR",
    "SCHEDULE_EVENT",
    "CREATE_EVENT",
    "UPDATE_EVENT",
    "DELETE_EVENT",
    "FIND_SLOTS",
  ],
  description:
    "Owner-facing calendar umbrella action. Op-based dispatch over the unified Google + Apple calendar feed: read_feed, create_event, update_event, delete_event, find_slots, next_event, describe_event, travel_buffer.",
  parameters: [
    {
      name: "action",
      description:
        "Canonical calendar sub-operation. Mirrors op for planner compatibility.",
      required: false,
      schema: { type: "string", enum: [...CALENDAR_OPS] },
    },
    {
      name: "op",
      description: "Which calendar sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...CALENDAR_OPS] },
    },
    {
      name: "eventId",
      description:
        "Target event id (update_event/delete_event/describe_event).",
      schema: { type: "string" },
    },
    {
      name: "startAt",
      description: "ISO start (create_event/find_slots window start).",
      schema: { type: "string" },
    },
    {
      name: "endAt",
      description: "ISO end (create_event/find_slots window end).",
      schema: { type: "string" },
    },
    {
      name: "timeZone",
      description: "IANA timezone for relative time queries.",
      schema: { type: "string" },
    },
    {
      name: "title",
      description: "Event title (create_event/update_event).",
      schema: { type: "string" },
    },
    {
      name: "query",
      description: "Free-text query (next_event/describe_event/find_slots).",
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts):
    // port the per-op validation (owner gate, calendar grant presence, etc.).
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as CalendarActionParameters;
    const op = readString(params.op) ?? readString(params.action);
    if (!op) return failure("missing_op", "No calendar op specified.");

    const known = CALENDAR_OPS as readonly string[];
    if (!known.includes(op)) {
      return failure("unknown_op", `Unsupported calendar op '${op}'.`);
    }

    switch (op as CalendarOp) {
      case "read_feed":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts read_feed branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.read_feed is not migrated yet.",
        );
      case "create_event":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts create_event branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.create_event is not migrated yet.",
        );
      case "update_event":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts update_event branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.update_event is not migrated yet.",
        );
      case "delete_event":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts delete_event branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.delete_event is not migrated yet.",
        );
      case "find_slots":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts find_slots branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.find_slots is not migrated yet.",
        );
      case "next_event":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts next_event branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.next_event is not migrated yet.",
        );
      case "describe_event":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts describe_event branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.describe_event is not migrated yet.",
        );
      case "travel_buffer":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/calendar.ts travel_buffer branch)
        return failure(
          "scaffold_stub",
          "CALENDAR.travel_buffer is not migrated yet.",
        );
      default:
        return failure("unknown_op", `Unsupported calendar op '${op}'.`);
    }
  },
  examples: [],
};

export default calendarAction;
