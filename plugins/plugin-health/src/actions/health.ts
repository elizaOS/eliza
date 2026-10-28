/**
 * HEALTH action implementation — planning, parameter parsing, metric
 * formatting, and response shaping for the owner's health/sleep queries. Host
 * plugins register this through the factories in `./index.ts`; the owner-scoped
 * runtime registration and LifeOps persistence stay in the host plugin.
 *
 * "Today" and the trend window are calendar days in the zone the host's
 * `resolveTimeZone` adapter returns (the owner's configured zone, or the
 * process zone), because HealthKit and connector day keys are device-local
 * days and the UTC day is already tomorrow or still yesterday for most owners.
 * An adapter that throws `CalendarTimeZoneError` (invalid or unreadable owner
 * zone) gets a visible failure reply rather than another zone's day.
 */

import {
  CALENDAR_TIME_ZONE_INVALID,
  CalendarTimeZoneError,
  normalizeTimeZone,
} from "@elizaos/contracts";
import type {
  Action,
  ActionParameter,
  ActionResult,
  GroundedActionReply,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ModelTypeName,
  State,
} from "@elizaos/core";
import {
  applyGroundedActionReply,
  ModelType,
  resolveOptimizedPromptForRuntime,
} from "@elizaos/core";
import type { LifeOpsHealthSummaryResponse } from "../contracts/health.js";
import type {
  HealthBackend,
  HealthDailySummary,
  HealthDataPoint,
} from "../health-bridge/health-bridge.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getZonedDateParts,
} from "../util/time.js";
import { HEALTH_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

export { HEALTH_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

type Subaction = "today" | "trend" | "by_metric" | "status";
type HealthMetric = HealthDataPoint["metric"];

const HEALTH_SUBACTIONS: readonly Subaction[] = [
  "today",
  "trend",
  "by_metric",
  "status",
];

const HEALTH_METRICS: readonly HealthMetric[] = [
  "steps",
  "heart_rate",
  "sleep_hours",
  "calories",
  "distance_meters",
  "active_minutes",
];

// Max bridge trend/by_metric window in days, matching the
// connector path's MAX_HEALTH_SUMMARY_DAYS (31): the bridge
// trend path fires one external call per day and renders every
// day's summary, so an unclamped window scales both with the
// requested span. The clamp applies to the bridge fallback
// branches only; the connector path keeps its own 400-above-31
// refusal.
const HEALTH_TREND_MAX_DAYS = 31;

export type HealthActionParameters = {
  subaction?: Subaction;
  intent?: string;
  metric?: HealthMetric;
  date?: string;
  days?: number;
};

export interface HealthActionService {
  getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt?: string;
  }>;
  getHealthSummary(request?: {
    days?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<LifeOpsHealthSummaryResponse>;
  /** Walks `days` local calendar days ending on today in `window.timeZone`. */
  getHealthTrend(
    days: number,
    window: { timeZone: string },
  ): Promise<HealthDailySummary[]>;
  getHealthDataPoints(
    opts: {
      metric: HealthDataPoint["metric"];
      startAt: string;
      endAt: string;
    },
    window: { timeZone: string },
  ): Promise<HealthDataPoint[]>;
  getHealthDailySummary(
    date: string,
    window: { timeZone: string },
  ): Promise<HealthDailySummary>;
}

export interface HealthActionRunJsonModelArgs {
  runtime: IAgentRuntime;
  prompt: string;
  actionType: string;
  failureMessage: string;
  source: string;
  modelType: ModelTypeName;
  purpose: string;
}

export interface CreateHealthActionRunnerOptions {
  hasAccess: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  createService: (runtime: IAgentRuntime) => HealthActionService;
  messageText: (message: Memory) => string;
  /** IANA zone whose calendar day is the owner's "today". */
  resolveTimeZone: (runtime: IAgentRuntime) => string | Promise<string>;
  renderReply: (args: {
    runtime: IAgentRuntime;
    message: Memory;
    state: State | undefined;
    intent: string;
    scenario: string;
    fallback: string;
    context?: Record<string, unknown>;
  }) => Promise<GroundedActionReply>;
  recentConversationTexts: (args: {
    runtime: IAgentRuntime;
    message: Memory;
    state: State | undefined;
  }) => Promise<string[]>;
  runJsonModel: (
    args: HealthActionRunJsonModelArgs,
  ) => Promise<{ parsed?: Record<string, unknown> | null } | null>;
}

function getParams(
  options: HandlerOptions | undefined,
): HealthActionParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | HealthActionParameters
    | undefined;
  return params ?? {};
}

function localTodayKey(timeZone: string): string {
  return getLocalDateKey(getZonedDateParts(new Date(), timeZone));
}

/**
 * Bounds of the owner's local calendar day `date` (YYYY-MM-DD) as instants.
 * Returns null when the string is not a real calendar date (e.g. 2026-02-31).
 */
function localDayBounds(
  date: string,
  timeZone: string,
): { startAt: string; endAt: string } | null {
  const [year, month, day] = date.split("-").map(Number);
  const start = { year, month, day };
  if (getLocalDateKey(addDaysToLocalDate(start, 0)) !== date) return null;
  const midnight = { hour: 0, minute: 0, second: 0 };
  return {
    startAt: buildUtcDateFromLocalParts(timeZone, {
      ...start,
      ...midnight,
    }).toISOString(),
    endAt: buildUtcDateFromLocalParts(timeZone, {
      ...addDaysToLocalDate(start, 1),
      ...midnight,
    }).toISOString(),
  };
}

function normalizeHealthSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (HEALTH_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as Subaction)
    : null;
}

function normalizeHealthMetric(value: unknown): HealthMetric | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (HEALTH_METRICS as readonly string[]).includes(normalized)
    ? (normalized as HealthMetric)
    : null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizeDays(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type HealthLlmPlan = {
  subaction: Subaction | null;
  metric: HealthMetric | null;
  days: number | null;
  shouldAct: boolean | null;
  response?: string;
};

async function resolveHealthPlanWithLlm(args: {
  adapters: CreateHealthActionRunnerOptions;
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: HealthActionParameters;
}): Promise<HealthLlmPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return {
      subaction: null,
      metric: null,
      days: null,
      shouldAct: null,
    };
  }

  const recentConversation = (
    await args.adapters.recentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
    })
  ).join("\n");
  const currentMessage = args.adapters.messageText(args.message);
  const paramsText = Object.entries(args.params)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  // Route the static planner instructions through OptimizedPromptService for
  // the `health_checkin` task (#8795). Falls back to HEALTH_PLAN_INSTRUCTIONS
  // verbatim when no optimized artifact is registered, so the composed prompt
  // is byte-identical to the prior inline version unless an optimization loads.
  const instructions = resolveOptimizedPromptForRuntime(
    args.runtime,
    "health_checkin",
    HEALTH_PLAN_INSTRUCTIONS,
  );
  const prompt = [
    instructions,
    "",
    "Current request:",
    currentMessage || "(empty)",
    "Resolved intent:",
    args.intent || "(none)",
    "Structured parameters:",
    paramsText || "(none)",
    "Recent conversation:",
    recentConversation || "(none)",
  ].join("\n");

  const result = await args.adapters.runJsonModel({
    runtime: args.runtime,
    prompt,
    actionType: "HEALTH.plan",
    failureMessage: "Health planning model call failed",
    source: "action:health",
    modelType: ModelType.TEXT_SMALL,
    // Tag this trajectory with the `health_checkin` LifeOps task (#8795) so it
    // buckets into the health_checkin training dataset — matching the
    // resolveOptimizedPromptForRuntime task above. The generic "planner" tag
    // normalizes to no known training task and was dropped on ingest, so the
    // health_checkin optimization loop collected zero real trajectories.
    purpose: "health_checkin",
  });
  const parsed = result?.parsed;
  if (!parsed) {
    return {
      subaction: null,
      metric: null,
      days: null,
      shouldAct: null,
    };
  }
  return {
    subaction: normalizeHealthSubaction(parsed.subaction),
    metric: normalizeHealthMetric(parsed.metric),
    days: normalizeDays(parsed.days),
    shouldAct: normalizeShouldAct(parsed.shouldAct),
    response: normalizePlannerResponse(parsed.response),
  };
}

/**
 * Heart rate is a rate, so readings are averaged; every other metric is a
 * count or amount and is summed. Callers pass at least one point: no samples
 * means no aggregate, not a zero.
 */
function aggregateMetricPoints(
  metric: string,
  points: readonly { value: number }[],
): { label: "average" | "total"; value: number } {
  const total = points.reduce((acc, point) => acc + point.value, 0);
  if (metric === "heart_rate") {
    return { label: "average", value: total / points.length };
  }
  return { label: "total", value: total };
}

function formatSummary(summary: {
  date: string;
  steps: number;
  activeMinutes: number;
  sleepHours: number;
  sleepUnavailable?: boolean;
  heartRateAvg?: number;
  calories?: number;
  distanceMeters?: number;
  source: string;
}): string {
  // A `sleepUnavailable` day carries `sleepHours: 0` only because the sleep
  // sub-fetch failed; rendering the zero would fabricate a real-looking
  // reading the bridge contract explicitly forbids (see HealthDailySummary).
  const sleepLine = summary.sleepUnavailable
    ? "- Sleep: unavailable (source error; sleep unknown for this day)"
    : `- Sleep: ${summary.sleepHours.toFixed(1)}h`;
  const parts: string[] = [
    `${summary.date} (${summary.source}):`,
    `- Steps: ${summary.steps.toLocaleString()}`,
    `- Active minutes: ${summary.activeMinutes}`,
    sleepLine,
  ];
  if (summary.heartRateAvg !== undefined) {
    parts.push(`- Heart rate avg: ${summary.heartRateAvg.toFixed(0)} bpm`);
  }
  if (summary.calories !== undefined) {
    parts.push(`- Calories: ${summary.calories.toFixed(0)}`);
  }
  if (summary.distanceMeters !== undefined) {
    parts.push(`- Distance: ${(summary.distanceMeters / 1000).toFixed(2)} km`);
  }
  return parts.join("\n");
}

/**
 * Steps, active minutes and sleep are 0 placeholders in a provider's daily
 * row when it sent no sample for them (Strava has no steps or sleep), so they
 * are shown only for metrics the provider reported that day.
 */
function formatConnectorDailySummary(
  summary: LifeOpsHealthSummaryResponse["summaries"][number],
  reportedMetrics: ReadonlySet<string>,
): string {
  const parts = [`${summary.date} (${summary.provider}):`];
  if (reportedMetrics.has("steps")) {
    parts.push(`- Steps: ${Math.round(summary.steps).toLocaleString()}`);
  }
  if (reportedMetrics.has("active_minutes")) {
    parts.push(`- Active minutes: ${Math.round(summary.activeMinutes)}`);
  }
  if (reportedMetrics.has("sleep_hours")) {
    parts.push(`- Sleep: ${summary.sleepHours.toFixed(1)}h`);
  }
  if (summary.heartRateAvg !== null) {
    parts.push(`- Heart rate avg: ${summary.heartRateAvg.toFixed(0)} bpm`);
  }
  if (summary.calories !== null) {
    parts.push(`- Calories: ${summary.calories.toFixed(0)}`);
  }
  if (summary.distanceMeters !== null) {
    parts.push(`- Distance: ${(summary.distanceMeters / 1000).toFixed(2)} km`);
  }
  if (summary.weightKg !== null) {
    parts.push(`- Weight: ${summary.weightKg.toFixed(1)} kg`);
  }
  return parts.join("\n");
}

/** The metrics a provider sent samples for on a summary row's day. */
function reportedConnectorMetrics(
  summary: LifeOpsHealthSummaryResponse,
  row: LifeOpsHealthSummaryResponse["summaries"][number],
): Set<string> {
  return new Set(
    summary.samples
      .filter(
        (sample) =>
          sample.provider === row.provider && sample.localDate === row.date,
      )
      .map((sample) => sample.metric),
  );
}

/**
 * Every provider's connector summary for `date`. Only a request that named no
 * date may read the latest synced day instead; an explicit date with no
 * summary is "no data for that day", never another day's numbers.
 */
function connectorSummariesForDate(
  summary: LifeOpsHealthSummaryResponse,
  date: string,
  explicitDate: boolean,
): LifeOpsHealthSummaryResponse["summaries"] {
  const matches = summary.summaries.filter(
    (candidate) => candidate.date === date,
  );
  if (matches.length > 0 || explicitDate) return matches;
  const latest = summary.summaries[0]?.date;
  return summary.summaries.filter((candidate) => candidate.date === latest);
}

export const HEALTH_SIMILES: readonly string[] = [
  "FITNESS",
  "WELLNESS",
  "SLEEP",
  "STEPS",
  "HEART_RATE",
  "WORKOUT",
  "EXERCISE",
  "CALORIES",
  "ACTIVITY_METRICS",
];

export const HEALTH_PARAMETERS: readonly ActionParameter[] = [
  {
    name: "subaction",
    description:
      "Which health query to run: today (default daily summary), trend (multi-day), by_metric (single metric), status (backend connectivity).",
    descriptionCompressed: "health query: today | trend | by_metric | status",
    schema: {
      type: "string" as const,
      enum: [...HEALTH_SUBACTIONS],
    },
    examples: ["today", "trend", "by_metric", "status"],
  },
  {
    name: "intent",
    description:
      "Free-form user intent used to infer subaction when not explicitly set.",
    descriptionCompressed: "free-form intent infer subaction",
    schema: { type: "string" as const },
  },
  {
    name: "metric",
    description:
      "Metric for by_metric queries: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
    descriptionCompressed:
      "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes",
    schema: {
      type: "string" as const,
      enum: [...HEALTH_METRICS],
    },
    examples: ["steps", "sleep_hours", "heart_rate"],
  },
  {
    name: "date",
    description:
      "YYYY-MM-DD local day for today and by_metric (by_metric then reads that day instead of the trailing days window). trend does not read it.",
    descriptionCompressed: "YYYY-MM-DD single day: today|by_metric",
    schema: {
      type: "string" as const,
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    },
    examples: ["2026-05-10"],
  },
  {
    name: "days",
    description:
      "Window size in days for trend and by_metric queries. Default: 7 for trend, 1 for by_metric. by_metric does not read it when date is set.",
    descriptionCompressed: "window days trend|by_metric",
    schema: { type: "number" as const, minimum: 1, maximum: 365 },
    examples: [1, 7, 30],
  },
];

export const OWNER_HEALTH_ACTIONS = [
  "today",
  "trend",
  "by_metric",
  "status",
] as const;

export interface CreateOwnerHealthActionOptions {
  validate: Action["validate"];
  handler: Action["handler"];
}

export function createOwnerHealthAction({
  validate,
  handler,
}: CreateOwnerHealthActionOptions): Action {
  return {
    name: "OWNER_HEALTH",
    similes: ["HEALTH", "FITNESS", "WELLNESS", ...HEALTH_SIMILES],
    description:
      "Owner health telemetry reads: HealthKit, Google Fit, Strava, Fitbit, Withings, Oura. Ops: today|trend|by_metric|status.",
    descriptionCompressed:
      "owner health: today|trend|by_metric|status; read-only telemetry",
    routingHint:
      'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH',
    parameters: [
      {
        name: "action",
        description: "Owner health read op: today|trend|by_metric|status.",
        required: false,
        schema: { type: "string" as const, enum: [...OWNER_HEALTH_ACTIONS] },
      },
      ...HEALTH_PARAMETERS.filter(
        (parameter) => parameter.name !== "subaction",
      ),
    ],
    validate,
    handler,
  };
}

export function createHealthActionRunner(
  adapters: CreateHealthActionRunnerOptions,
): (
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
) => Promise<ActionResult> {
  return async function runHealthHandler(
    runtime,
    message,
    state,
    options,
    callback,
  ) {
    const intent = adapters.messageText(message).trim();

    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      scenario: string;
      fallback: string;
      context?: Record<string, unknown>;
      data?: T;
      values?: ActionResult["values"];
    }): Promise<ActionResult> => {
      const reply = await adapters.renderReply({
        runtime,
        message,
        state,
        intent,
        scenario: payload.scenario,
        fallback: payload.fallback,
        context: payload.context,
      });
      if (reply.kind === "model") {
        await callback?.({
          text: reply.text,
          source: "action",
          action: "HEALTH",
        });
      }
      return applyGroundedActionReply(
        {
          success: payload.success,
          ...(payload.values ? { values: payload.values } : {}),
          ...(payload.data ? { data: payload.data } : {}),
        },
        reply,
      );
    };

    if (!(await adapters.hasAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Health data is restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const params = getParams(options);
    const body = adapters.messageText(message);
    const explicitSubaction = normalizeHealthSubaction(params.subaction);
    let subaction: Subaction | null = explicitSubaction;
    let plannedMetric: HealthMetric | null = null;
    let plannedDays: number | null = null;
    if (!subaction) {
      const planIntent = (params.intent ?? body).trim();
      const plan = await resolveHealthPlanWithLlm({
        adapters,
        runtime,
        message,
        state,
        intent: planIntent,
        params,
      });
      subaction = plan.subaction;
      plannedMetric = plan.metric;
      plannedDays = plan.days;
      if (plan.shouldAct === false || !subaction) {
        const fallback =
          plan.response ??
          "Tell me whether you want today's summary, a multi-day trend, a specific metric, or backend status.";
        return respond({
          success: false,
          scenario: "planner_clarification",
          fallback,
          context: { suggestedSubaction: subaction },
          values: {
            success: false,
            error: "PLANNER_SHOULDACT_FALSE",
            skipped: true,
            suggestedSubaction: subaction,
          },
          data: {
            skipped: true,
            error: "PLANNER_SHOULDACT_FALSE",
            suggestedSubaction: subaction,
          },
        });
      }
    }
    const service = adapters.createService(runtime);
    let timeZone: string;
    try {
      timeZone = normalizeTimeZone(await adapters.resolveTimeZone(runtime));
    } catch (error) {
      if (!(error instanceof CalendarTimeZoneError)) throw error;
      // error-policy:J4 the owner's zone is unreadable or invalid; a summary
      // for another zone's day would be a wrong answer reported as success.
      return respond({
        success: false,
        scenario: "health_time_zone_unavailable",
        fallback:
          error.code === CALENDAR_TIME_ZONE_INVALID
            ? "I can't tell which day is today for you: your saved time zone isn't valid. Tell me your time zone and I'll check your health data."
            : "I can't read your time zone right now, so I can't tell which day is today for you. Please try again shortly.",
        data: { error: error.code },
      });
    }

    const dayBounds =
      subaction === "by_metric" && params.date
        ? localDayBounds(params.date, timeZone)
        : undefined;
    if (dayBounds === null) {
      return respond({
        success: false,
        scenario: "health_invalid_date",
        fallback: `${params.date} is not a calendar date. Use YYYY-MM-DD.`,
        data: { error: "INVALID_DATE" },
      });
    }

    // by_metric reads one window on both the bridge and the connector path,
    // and names it in the reply.
    const byMetricDays =
      params.days && params.days > 0
        ? Math.floor(params.days)
        : (plannedDays ?? 1);
    const byMetricWindowLabel =
      params.date ?? `last ${byMetricDays} day${byMetricDays === 1 ? "" : "s"}`;
    // The reply model reads this context; a dated read must not also claim a
    // trailing `days` window.
    const byMetricWindowContext = params.date
      ? { date: params.date }
      : { days: byMetricDays };

    const connectorStatus = await service.getHealthConnectorStatus();
    let healthSummary: LifeOpsHealthSummaryResponse | null = null;
    // A single-day read for a named date must fetch that day; the default
    // trailing window ends today and would miss an older date.
    const summaryRequest =
      (subaction === "today" || subaction === "by_metric") && params.date
        ? { startDate: params.date, endDate: params.date }
        : subaction === "by_metric"
          ? { days: byMetricDays }
          : { days: plannedDays ?? params.days ?? 7 };
    try {
      healthSummary = await service.getHealthSummary(summaryRequest);
    } catch (error) {
      // error-policy:J4 the connector summary is one input to the health
      // response; a load failure must not read as "no providers connected", so
      // reportError surfaces it (via RECENT_ERRORS the agent can retry/reconnect)
      // while the response still renders from the separate connectorStatus.
      runtime.reportError("Health.connectorSummary", error, {
        subaction,
        ...summaryRequest,
      });
      runtime.logger.warn(
        {
          src: "action:health",
          error: error instanceof Error ? error.message : String(error),
        },
        "LifeOps health connector summary failed to load",
      );
    }
    const connectedProviders =
      healthSummary?.providers
        .filter((provider) => provider.connected)
        .map((provider) => provider.provider) ?? [];

    if (subaction === "status") {
      const connectorText =
        connectedProviders.length > 0
          ? ` Connected providers: ${connectedProviders.join(", ")}.`
          : "";
      const fallback = connectorStatus.available
        ? `Health backend available: ${connectorStatus.backend}.${connectorText}`
        : `No HealthKit/Google Fit bridge available.${connectorText || " Connect Strava, Fitbit, Withings, or Oura in LifeOps settings."}`;
      return respond({
        success: true,
        scenario: "health_status",
        fallback,
        context: {
          backendAvailable: connectorStatus.available,
          backend: connectorStatus.backend,
          connectedProviders,
        },
        values: {
          success: true,
          healthBackendAvailable: connectorStatus.available,
          healthBackend: connectorStatus.backend,
          healthConnectedProviders: connectedProviders,
        },
        data: {
          subaction,
          status: connectorStatus,
          healthConnectors: healthSummary?.providers ?? [],
        },
      });
    }

    if (!connectorStatus.available) {
      if (healthSummary && connectedProviders.length > 0) {
        if (subaction === "trend") {
          const days =
            params.days && params.days > 0
              ? Math.floor(params.days)
              : (plannedDays ?? 7);
          const fallback =
            healthSummary.summaries.length === 0
              ? `No wearable health data recorded in the last ${days} days.`
              : `Health trend (last ${days} days):\n${healthSummary.summaries
                  .map((entry) =>
                    formatConnectorDailySummary(
                      entry,
                      reportedConnectorMetrics(healthSummary, entry),
                    ),
                  )
                  .join("\n\n")}`;
          return respond({
            success: true,
            scenario: "health_connector_trend",
            fallback,
            context: { days, summaries: healthSummary.summaries },
            values: {
              success: true,
              healthConnectedProviders: connectedProviders,
            },
            data: { subaction, days, healthSummary },
          });
        }
        if (subaction === "by_metric") {
          const metric = normalizeHealthMetric(params.metric) ?? plannedMetric;
          if (!metric) {
            return respond({
              success: false,
              scenario: "health_missing_metric",
              fallback:
                "Specify a metric: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
              data: { error: "MISSING_METRIC" },
            });
          }
          const points = healthSummary.samples.filter(
            (sample) => sample.metric === metric,
          );
          const firstPoint = points[0];
          if (!firstPoint) {
            return respond({
              success: true,
              scenario: "health_connector_by_metric",
              fallback: params.date
                ? `No ${metric} data recorded by connected health providers on ${params.date}.`
                : `No ${metric} data recorded by connected health providers in the ${byMetricWindowLabel}.`,
              context: { metric, ...byMetricWindowContext, sampleCount: 0 },
              values: {
                success: true,
                healthConnectedProviders: connectedProviders,
              },
              data: { subaction, metric, points, healthSummary },
            });
          }
          // Providers can record the same activity (a Fitbit day total
          // includes a run Strava also reports), so each provider is
          // aggregated on its own and never added to another.
          const byProvider = [
            ...new Set(points.map((point) => point.provider)),
          ].map((provider) => {
            const providerPoints = points.filter(
              (point) => point.provider === provider,
            );
            return {
              provider,
              sampleCount: providerPoints.length,
              ...aggregateMetricPoints(metric, providerPoints),
            };
          });
          const samples = (count: number) =>
            `${count} sample${count === 1 ? "" : "s"}`;
          const only = byProvider.length === 1 ? byProvider[0] : undefined;
          const fallback = only
            ? `${metric} — ${byMetricWindowLabel}: ${only.label} ${only.value.toFixed(2)} ${firstPoint.unit} across ${samples(points.length)}.`
            : `${metric} — ${byMetricWindowLabel}, by provider (providers can record the same activity, so these are not added together): ${byProvider
                .map(
                  (entry) =>
                    `${entry.provider} ${entry.label} ${entry.value.toFixed(2)} ${firstPoint.unit} across ${samples(entry.sampleCount)}`,
                )
                .join("; ")}.`;
          return respond({
            success: true,
            scenario: "health_connector_by_metric",
            fallback,
            context: {
              metric,
              ...byMetricWindowContext,
              ...(only ? { [only.label]: only.value } : { byProvider }),
              unit: firstPoint.unit,
              sampleCount: points.length,
            },
            values: {
              success: true,
              healthConnectedProviders: connectedProviders,
            },
            data: { subaction, metric, points, healthSummary },
          });
        }
        const dailyByProvider = connectorSummariesForDate(
          healthSummary,
          params.date ?? localTodayKey(timeZone),
          params.date !== undefined,
        );
        const daily = dailyByProvider[0] ?? null;
        const fallback = daily
          ? `Health summary for ${dailyByProvider
              .map((row) =>
                formatConnectorDailySummary(
                  row,
                  reportedConnectorMetrics(healthSummary, row),
                ),
              )
              .join("\n\n")}`
          : params.date
            ? `Connected health providers have no daily summary for ${params.date}.`
            : "Connected health providers have not synced daily summaries yet.";
        return respond({
          success: true,
          scenario: "health_connector_today",
          fallback,
          context: {
            daily,
            ...(dailyByProvider.length > 1 ? { dailyByProvider } : {}),
          },
          values: {
            success: true,
            healthConnectedProviders: connectedProviders,
          },
          data: { subaction: "today", healthSummary },
        });
      }
      return respond({
        success: true,
        scenario: "health_no_backend",
        fallback:
          "I don't have a health data source connected yet. Connect Apple Health, Google Fit, Strava, Fitbit, Withings, or Oura and I'll pick it up.",
        context: { connectedProviders, backend: connectorStatus.backend },
        values: {
          success: true,
          healthBackendAvailable: false,
          healthConnectedProviders: connectedProviders,
        },
        data: { subaction, status: connectorStatus, degraded: "no-backend" },
      });
    }

    if (subaction === "trend") {
      const days = Math.min(
        params.days && params.days > 0
          ? Math.floor(params.days)
          : (plannedDays ?? 7),
        HEALTH_TREND_MAX_DAYS,
      );
      const trend = await service.getHealthTrend(days, { timeZone });
      const fallback =
        trend.length === 0
          ? `No health data recorded in the last ${days} days.`
          : `Health trend (last ${days} days):\n${trend
              .map((s) => formatSummary(s))
              .join("\n\n")}`;
      return respond({
        success: true,
        scenario: "health_trend",
        fallback,
        context: { days, pointCount: trend.length, trend },
        values: { success: true, days, pointCount: trend.length },
        data: { subaction, days, trend },
      });
    }

    if (subaction === "by_metric") {
      const metric = normalizeHealthMetric(params.metric) ?? plannedMetric;
      if (!metric) {
        return respond({
          success: false,
          scenario: "health_missing_metric",
          fallback:
            "Specify a metric: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
          data: { error: "MISSING_METRIC" },
        });
      }
      // A named date reads that local calendar day; otherwise the trailing
      // `days` window ending now.
      // The bridge by_metric window is clamped like the trend
      // window; a named date reads that day and ignores the
      // trailing window entirely, so its label is untouched.
      const bridgeDays = Math.min(byMetricDays, HEALTH_TREND_MAX_DAYS);
      const { startAt, endAt } = dayBounds ?? {
        startAt: new Date(
          Date.now() - bridgeDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
        endAt: new Date().toISOString(),
      };
      const windowLabel = dayBounds
        ? byMetricWindowLabel
        : `last ${bridgeDays} day${bridgeDays === 1 ? "" : "s"}`;
      const windowContext = byMetricWindowContext;
      const points = await service.getHealthDataPoints(
        { metric, startAt, endAt },
        { timeZone },
      );
      const firstPoint = points[0];
      if (!firstPoint) {
        const fallback = params.date
          ? `No ${metric} data recorded on ${params.date}.`
          : `No ${metric} data recorded in the ${windowLabel}.`;
        return respond({
          success: true,
          scenario: "health_by_metric_empty",
          fallback,
          context: { metric, ...windowContext },
          values: { success: true, metric, pointCount: points.length },
          data: { subaction, metric, startAt, endAt, points },
        });
      }
      const aggregate = aggregateMetricPoints(metric, points);
      const fallback = `${metric} — ${windowLabel}: ${aggregate.label} ${aggregate.value.toFixed(
        2,
      )} ${firstPoint.unit} across ${points.length} sample${points.length === 1 ? "" : "s"}.`;
      return respond({
        success: true,
        scenario: "health_by_metric",
        fallback,
        context: {
          metric,
          ...windowContext,
          [aggregate.label]: aggregate.value,
          unit: firstPoint.unit,
          sampleCount: points.length,
        },
        values: { success: true, metric, pointCount: points.length },
        data: { subaction, metric, startAt, endAt, points },
      });
    }

    const date = params.date ?? localTodayKey(timeZone);
    const summary = await service.getHealthDailySummary(date, { timeZone });
    const fallback = `Health summary for ${formatSummary(summary)}`;
    return respond({
      success: true,
      scenario: "health_today",
      fallback,
      context: {
        date,
        steps: summary.steps,
        activeMinutes: summary.activeMinutes,
        sleepHours: summary.sleepHours,
        ...(summary.sleepUnavailable ? { sleepUnavailable: true } : {}),
      },
      values: {
        success: true,
        steps: summary.steps,
        activeMinutes: summary.activeMinutes,
        sleepHours: summary.sleepHours,
        ...(summary.sleepUnavailable ? { sleepUnavailable: true } : {}),
      },
      data: { subaction: "today", date, summary },
    });
  };
}
