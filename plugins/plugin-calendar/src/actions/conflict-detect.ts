import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * CONFLICT_DETECT calendar-conflict scanner action — STUB.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/conflict-detect.ts)
 *
 * Reference subactions to port (see lifeops source `SUBACTIONS`):
 *   - scan_today: surface overlapping events for today.
 *   - scan_week:  surface overlapping events across the rolling week.
 *   - scan_event_proposal: check a proposed window vs the owner feed.
 *
 * For now this returns `scaffold_stub` so callers see exactly which subaction
 * needs to be migrated.
 */

const CONFLICT_DETECT_OPS = [
  "scan_today",
  "scan_week",
  "scan_event_proposal",
] as const;

type ConflictDetectOp = (typeof CONFLICT_DETECT_OPS)[number];

interface ConflictDetectParameters {
  action?: unknown;
  op?: unknown;
  range?: unknown;
  proposal?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function failure(reason: string, message: string): ActionResult {
  const text = `[CONFLICT_DETECT scaffold_stub] ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

export const conflictDetectAction: Action = {
  name: "CONFLICT_DETECT",
  similes: [
    "DETECT_CONFLICTS",
    "SCAN_CONFLICTS",
    "CONFLICTS_TODAY",
    "CONFLICTS_WEEK",
    "CHECK_OVERLAP",
  ],
  description:
    "Scan the owner calendar for overlaps. Subactions: scan_today, scan_week, scan_event_proposal. Returns a severity-graded conflict list.",
  parameters: [
    {
      name: "action",
      description:
        "Conflict op: scan_today | scan_week | scan_event_proposal.",
      required: true,
      schema: { type: "string", enum: [...CONFLICT_DETECT_OPS] },
    },
    {
      name: "range",
      description:
        "'today' | 'week' or { start, end } ISO window. Default subaction range.",
      schema: { type: "object", additionalProperties: true },
    },
    {
      name: "proposal",
      description:
        "scan_event_proposal candidate: { startISO, endISO, attendees? }.",
      schema: { type: "object", additionalProperties: true },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/conflict-detect.ts):
    // port the owner role gate + lifeops access check.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as ConflictDetectParameters;
    const op = readString(params.action) ?? readString(params.op);
    if (!op) {
      return failure(
        "missing_op",
        "Tell me which scan to run: scan_today, scan_week, or scan_event_proposal.",
      );
    }

    const known = CONFLICT_DETECT_OPS as readonly string[];
    if (!known.includes(op)) {
      return failure("unknown_op", `Unsupported conflict op '${op}'.`);
    }

    switch (op as ConflictDetectOp) {
      case "scan_today":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/conflict-detect.ts scan_today branch)
        return failure(
          "scaffold_stub",
          "CONFLICT_DETECT.scan_today is not migrated yet.",
        );
      case "scan_week":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/conflict-detect.ts scan_week branch)
        return failure(
          "scaffold_stub",
          "CONFLICT_DETECT.scan_week is not migrated yet.",
        );
      case "scan_event_proposal":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/conflict-detect.ts scan_event_proposal branch)
        return failure(
          "scaffold_stub",
          "CONFLICT_DETECT.scan_event_proposal is not migrated yet.",
        );
      default:
        return failure("unknown_op", `Unsupported conflict op '${op}'.`);
    }
  },
  examples: [],
};

export default conflictDetectAction;
