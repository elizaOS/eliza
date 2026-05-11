/**
 * LifeOps health action — query health & fitness metrics from HealthKit or
 * Google Fit via the LifeOps health bridge.
 *
 * Subactions: today, trend, by_metric, status.
 *
 * Every user-visible reply runs through `renderLifeOpsActionReply` so the raw
 * data templates land in the agent's character voice instead of being streamed
 * raw. The structured `data` payload on each ActionResult is preserved verbatim
 * for downstream consumers (ACTION_STATE provider, scenario assertions, UI).
 */

import type {
  ActionParameter,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { LifeOpsHealthSummaryResponse } from "../contracts/index.js";
import type { HealthDataPoint } from "@elizaos/plugin-health";
import { LifeOpsService } from "../lifeops/service.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./lib/recent-context.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { runLifeOpsJsonModel } from "../lifeops/google/format-helpers.js";
import {
  messageText as getMessageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";

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

type HealthParameters = {
  subaction?: Subaction;
  intent?: string;
  metric?: HealthMetric;
  date?: string;
  days?: number;
};

function getParams(options: HandlerOptions | undefined): HealthParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | HealthParameters
    | undefined;
  return params ?? {};
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: HealthParameters;
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
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");
  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text
      : "";
  const paramsText = Object.entries(args.params ?? {})
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  const prompt = [
    "Plan the HEALTH action for this request.",
    "The user may speak in any language.",
    "Return JSON only as a single object with exactly these fields:",
    "subaction: today|trend|by_metric|status|null",
    "metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes|null",
    "days: number|null",
    "shouldAct: true|false",
    "response: string|null",
    "",
    "Choose status when the user asks about health backend connection or availability.",
    "Choose trend when the user asks for fitness/health activity over a window of days, a week, or recent history.",
    "Choose by_metric when the user names a specific metric and wants its current or recent value.",
    "Choose today (default) when the user asks for today's overall summary.",
    "metric must be one of the listed enum values when subaction=by_metric, otherwise null.",
    "days must be a positive integer the user implies (e.g. 7 for 'this week'); null when not stated.",
    "Set shouldAct=false only when the request is too vague to choose any subaction.",
    "When shouldAct=false, response must be a short clarifying question in the user's language.",
    "",
    'Example: {"subaction":"today","metric":null,"days":null,"shouldAct":true,"response":null}',
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

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "HEALTH.plan",
    failureMessage: "Health planning model call failed",
    source: "action:health",
    modelType: ModelType.TEXT_SMALL,
    purpose: "planner",
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

function formatSummary(summary: {
  date: string;
  steps: number;
  activeMinutes: number;
  sleepHours: number;
  heartRateAvg?: number;
  calories?: number;
  distanceMeters?: number;
  source: string;
}): string {
  const parts: string[] = [
    `${summary.date} (${summary.source}):`,
    `- Steps: ${summary.steps.toLocaleString()}`,
    `- Active minutes: ${summary.activeMinutes}`,
    `- Sleep: ${summary.sleepHours.toFixed(1)}h`,
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

function formatConnectorDailySummary(
  summary: LifeOpsHealthSummaryResponse["summaries"][number],
): string {
  const parts = [
    `${summary.date} (${summary.provider}):`,
    `- Steps: ${Math.round(summary.steps).toLocaleString()}`,
    `- Active minutes: ${Math.round(summary.activeMinutes)}`,
    `- Sleep: ${summary.sleepHours.toFixed(1)}h`,
  ];
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

function latestConnectorSummaryForDate(
  summary: LifeOpsHealthSummaryResponse,
  date: string,
): LifeOpsHealthSummaryResponse["summaries"][number] | null {
  return (
    summary.summaries.find((candidate) => candidate.date === date) ??
    summary.summaries[0] ??
    null
  );
}

/**
 * Public similes preserved on the OWNER_HEALTH umbrella for cached planner
 * output / lifeops provider routing hints.
 */
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

/**
 * Parameter schema for the HEALTH backend — the OWNER_HEALTH umbrella
 * surfaces this as its public param list (after replacing `subaction` with
 * a canonical `action` discriminator).
 */
export const HEALTH_PARAMETERS: readonly ActionParameter[] = [
  {
    name: "subaction",
    description:
      "Which health query to run: today (default daily summary), trend (multi-day), by_metric (single metric), status (backend connectivity).",
    descriptionCompressed:
      "health query: today | trend | by_metric | status",
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
    description: "YYYY-MM-DD for single-day queries.",
    descriptionCompressed: "YYYY-MM-DD single-day",
    schema: { type: "string" as const },
    examples: ["2026-05-10"],
  },
  {
    name: "days",
    description: "Window size for trend and by_metric queries.",
    descriptionCompressed: "window days trend|by_metric",
    schema: { type: "number" as const, minimum: 1, maximum: 365 },
    examples: [1, 7, 30],
  },
];

/**
 * Handler function backing the OWNER_HEALTH umbrella.
 *
 * Folded out of the legacy `HEALTH` action surface — Audit F. The umbrella
 * in `./owner-surfaces.ts` is the only caller; no `HEALTH`-named action is
 * registered.
 */
export async function runHealthHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: unknown,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
    const intent = getMessageText(message).trim();

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
      const text = await renderLifeOpsActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: payload.scenario,
        fallback: payload.fallback,
        context: payload.context,
      });
      await callback?.({ text, source: "action", action: "HEALTH" });
      return {
        text,
        success: payload.success,
        ...(payload.values ? { values: payload.values } : {}),
        ...(payload.data ? { data: payload.data } : {}),
      };
    };

    if (!(await hasLifeOpsAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Health data is restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const params = getParams(options);
    const body = getMessageText(message);
    const explicitSubaction = normalizeHealthSubaction(params.subaction);
    let subaction: Subaction | null = explicitSubaction;
    let plannedMetric: HealthMetric | null = null;
    let plannedDays: number | null = null;
    if (!subaction) {
      const planIntent = (params.intent ?? body).trim();
      const plan = await resolveHealthPlanWithLlm({
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
            noop: true,
            suggestedSubaction: subaction,
          },
          data: {
            noop: true,
            error: "PLANNER_SHOULDACT_FALSE",
            suggestedSubaction: subaction,
          },
        });
      }
    }
    const service = new LifeOpsService(runtime);

    // Single availability probe shared by every subaction below. When no
    // backend is configured we surface a clear, conversational reply rather
    // than throwing a `HealthBridgeError` that bubbles up as a raw server
    // error to the scenario runtime and to end users.
    const connectorStatus = await service.getHealthConnectorStatus();
    let healthSummary: LifeOpsHealthSummaryResponse | null = null;
    try {
      healthSummary = await service.getHealthSummary({
        days: plannedDays ?? params.days ?? 7,
      });
    } catch (error) {
      runtime.logger?.warn?.(
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
                  .map((entry) => formatConnectorDailySummary(entry))
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
          const total = points.reduce((acc, point) => acc + point.value, 0);
          const fallback = firstPoint
            ? `${metric}: total ${total.toFixed(2)} ${firstPoint.unit} across ${points.length} sample${points.length === 1 ? "" : "s"}.`
            : `No ${metric} data recorded by connected health providers.`;
          return respond({
            success: true,
            scenario: "health_connector_by_metric",
            fallback,
            context: {
              metric,
              total,
              unit: firstPoint?.unit,
              sampleCount: points.length,
            },
            values: {
              success: true,
              healthConnectedProviders: connectedProviders,
            },
            data: { subaction, metric, points, healthSummary },
          });
        }
        const daily = latestConnectorSummaryForDate(
          healthSummary,
          params.date ?? todayIso(),
        );
        const fallback = daily
          ? `Health summary for ${formatConnectorDailySummary(daily)}`
          : "Connected health providers have not synced daily summaries yet.";
        return respond({
          success: true,
          scenario: "health_connector_today",
          fallback,
          context: { daily },
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
      const days =
        params.days && params.days > 0
          ? Math.floor(params.days)
          : (plannedDays ?? 7);
      const trend = await service.getHealthTrend(days);
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
      const days =
        params.days && params.days > 0
          ? Math.floor(params.days)
          : (plannedDays ?? 1);
      const endAt = new Date().toISOString();
      const startAt = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      const points = await service.getHealthDataPoints({
        metric,
        startAt,
        endAt,
      });
      const total = points.reduce((acc, p) => acc + p.value, 0);
      const firstPoint = points[0];
      if (!firstPoint) {
        const fallback = `No ${metric} data recorded in the last ${days} day${days === 1 ? "" : "s"}.`;
        return respond({
          success: true,
          scenario: "health_by_metric_empty",
          fallback,
          context: { metric, days },
          values: { success: true, metric, pointCount: points.length },
          data: { subaction, metric, startAt, endAt, points },
        });
      }
      const fallback =
        points.length === 0
          ? `No ${metric} data recorded in the last ${days} day${days === 1 ? "" : "s"}.`
          : `${metric} — last ${days} day${days === 1 ? "" : "s"}: total ${total.toFixed(
              2,
            )} ${firstPoint.unit} across ${points.length} sample${points.length === 1 ? "" : "s"}.`;
      return respond({
        success: true,
        scenario: "health_by_metric",
        fallback,
        context: {
          metric,
          days,
          total,
          unit: firstPoint.unit,
          sampleCount: points.length,
        },
        values: { success: true, metric, pointCount: points.length },
        data: { subaction, metric, startAt, endAt, points },
      });
    }

    // today — default
    const date = params.date ?? todayIso();
    const summary = await service.getHealthDailySummary(date);
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
      },
      values: {
        success: true,
        steps: summary.steps,
        activeMinutes: summary.activeMinutes,
        sleepHours: summary.sleepHours,
      },
      data: { subaction: "today", date, summary },
    });
}
