import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * OWNER_SCREENTIME umbrella action (owner-facing) — extracted scaffold.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/screen-time.ts)
 *
 * The full owner-facing screen-time action — covering `summary`, `today`,
 * `weekly`, `weekly_average_by_app`, `by_app`, `by_website`,
 * `activity_report`, `time_on_app`, `time_on_site`, and `browser_activity`
 * subactions — will be ported here in a follow-up pass once the scheduler /
 * owner-state foundations and the LifeOps screen-time repository move into
 * this plugin. For now this scaffold registers the action name so the runtime
 * can resolve it; the handler returns a typed `scaffold_stub` failure pointing
 * back at the source.
 *
 * Reference factory for the host-adapted form lives in
 * `plugins/plugin-health/src/actions/screen-time.ts` (createOwnerScreenTimeAction).
 */

const ACTION_NAME = "OWNER_SCREENTIME" as const;
const FAILURE_PREFIX = "[plugin-health/OWNER_SCREENTIME]" as const;

const SCREENTIME_SUBACTIONS = [
  "summary",
  "today",
  "weekly",
  "weekly_average_by_app",
  "by_app",
  "by_website",
  "activity_report",
  "time_on_app",
  "time_on_site",
  "browser_activity",
] as const;
type ScreentimeSubaction = (typeof SCREENTIME_SUBACTIONS)[number];

interface OwnerScreentimeParameters {
  subaction?: unknown;
  source?: unknown;
  identifier?: unknown;
  date?: unknown;
  days?: unknown;
  limit?: unknown;
  windowDays?: unknown;
  windowHours?: unknown;
  appNameOrBundleId?: unknown;
  domain?: unknown;
  deviceId?: unknown;
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

export const ownerScreentimeAction: Action = {
  name: ACTION_NAME,
  similes: [
    "SCREEN_TIME",
    "SCREENTIME",
    "SCREEN_TIME_SUMMARY",
    "SCREEN_TIME_TODAY",
  ],
  description:
    "Owner-facing screen-time umbrella action: summaries, daily/weekly breakdowns, per-app / per-website slices, browser activity reports, and time-on-target queries across iOS / Android / desktop signals.",
  parameters: [
    {
      name: "subaction",
      description: "Which screen-time sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...SCREENTIME_SUBACTIONS] },
    },
    {
      name: "source",
      description: "Aggregation source — 'app' or 'website'.",
      schema: { type: "string" },
    },
    {
      name: "identifier",
      description: "Bundle id, package name, or domain to filter on.",
      schema: { type: "string" },
    },
    {
      name: "date",
      description: "ISO date (YYYY-MM-DD) to anchor a daily query.",
      schema: { type: "string" },
    },
    {
      name: "days",
      description: "Multi-day window length.",
      schema: { type: "number" },
    },
    {
      name: "windowHours",
      description: "Window length in hours (1..720).",
      schema: { type: "number" },
    },
    {
      name: "deviceId",
      description: "Restrict to a specific device id.",
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/screen-time.ts) — port
    // the owner-state / role-gate validation once foundations land. For now we
    // accept the call and let the handler emit a typed scaffold failure.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as OwnerScreentimeParameters;
    const subaction = readString(params.subaction);
    if (!subaction) {
      return failure("missing_subaction", "No subaction specified.");
    }
    const known = SCREENTIME_SUBACTIONS as readonly string[];
    if (!known.includes(subaction)) {
      return failure(
        "unknown_subaction",
        `Unsupported subaction '${subaction}'.`,
      );
    }

    // Single TODO covers every branch: the migration target is the matching
    // case in `plugin-lifeops/src/actions/screen-time.ts`.
    // TODO(migrate: plugins/plugin-lifeops/src/actions/screen-time.ts)
    return failure(
      "scaffold_stub",
      `OWNER_SCREENTIME.${subaction as ScreentimeSubaction} is not migrated yet.`,
    );
  },
  examples: [],
};

export default ownerScreentimeAction;
