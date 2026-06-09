import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * OWNER_HEALTH umbrella action (owner-facing) — extracted scaffold.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts)
 *
 * The full owner-facing health action — covering `today`, `trend`, `by_metric`,
 * and `status` subactions over the LifeOps owner-state + health-connector
 * service surface — will be ported here in a follow-up pass once the
 * scheduler / owner-state foundations land. For now this scaffold registers
 * the action name so the runtime can resolve it; the handler returns a typed
 * `scaffold_stub` failure pointing back at the source.
 *
 * Reference factory for the host-adapted form lives in
 * `plugins/plugin-health/src/actions/health.ts` (createOwnerHealthAction).
 */

const ACTION_NAME = "OWNER_HEALTH" as const;
const FAILURE_PREFIX = "[plugin-health/OWNER_HEALTH]" as const;

const HEALTH_SUBACTIONS = ["today", "trend", "by_metric", "status"] as const;
type HealthSubaction = (typeof HEALTH_SUBACTIONS)[number];

interface OwnerHealthParameters {
  action?: unknown;
  subaction?: unknown;
  metric?: unknown;
  date?: unknown;
  days?: unknown;
}

function failure(reason: string, message: string): ActionResult {
  const text = `${FAILURE_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export const ownerHealthAction: Action = {
  name: ACTION_NAME,
  similes: ["HEALTH", "HEALTH_SUMMARY", "HEALTH_TODAY", "HEALTH_TREND"],
  description:
    "Owner-facing health umbrella action: surface today's health summary, multi-day trends, per-metric breakdowns, and connector status (Apple Health / Google Fit / Strava / Fitbit / Withings / Oura).",
  parameters: [
    {
      name: "action",
      description: "Which health sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...HEALTH_SUBACTIONS] },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      schema: { type: "string", enum: [...HEALTH_SUBACTIONS] },
    },
    {
      name: "metric",
      description:
        "Specific metric to query (steps, heart_rate, sleep_hours, calories, distance_meters, active_minutes).",
      schema: { type: "string" },
    },
    {
      name: "date",
      description: "ISO date (YYYY-MM-DD) to query.",
      schema: { type: "string" },
    },
    {
      name: "days",
      description: "Trend window length in days.",
      schema: { type: "number" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts) — port the
    // owner-state / role-gate validation once the foundations land. For now
    // we accept the call and let the handler emit a typed scaffold failure.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as OwnerHealthParameters;
    const subaction = readString(params.action) ?? readString(params.subaction);
    if (!subaction) {
      return failure("missing_subaction", "No subaction specified.");
    }
    const known = HEALTH_SUBACTIONS as readonly string[];
    if (!known.includes(subaction)) {
      return failure(
        "unknown_subaction",
        `Unsupported subaction '${subaction}'.`,
      );
    }

    switch (subaction as HealthSubaction) {
      case "today":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts — today branch)
        return failure(
          "scaffold_stub",
          "OWNER_HEALTH.today is not migrated yet.",
        );
      case "trend":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts — trend branch)
        return failure(
          "scaffold_stub",
          "OWNER_HEALTH.trend is not migrated yet.",
        );
      case "by_metric":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts — by_metric branch)
        return failure(
          "scaffold_stub",
          "OWNER_HEALTH.by_metric is not migrated yet.",
        );
      case "status":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/health.ts — status branch)
        return failure(
          "scaffold_stub",
          "OWNER_HEALTH.status is not migrated yet.",
        );
      default:
        return failure(
          "unknown_subaction",
          `Unsupported subaction '${subaction}'.`,
        );
    }
  },
  examples: [],
};

export default ownerHealthAction;
