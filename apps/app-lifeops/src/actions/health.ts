/**
 * LifeOps health action — query health & fitness metrics from HealthKit or
 * Google Fit via the LifeOps health bridge.
 *
 * Subactions: today, trend, by_metric, status.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import type { HealthDataPoint } from "../lifeops/health-bridge.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";

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

function messageText(message: Memory): string {
  return (message?.content?.text ?? "").toString();
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
  const prompt = [
    "Plan the HEALTH action for this request.",
    "The user may speak in any language.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"today"|"trend"|"by_metric"|"status"|null,"metric":"steps"|"heart_rate"|"sleep_hours"|"calories"|"distance_meters"|"active_minutes"|null,"days":number|null,"shouldAct":true|false,"response":"string|null"}',
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
    "Examples (any language):",
    '  "How many steps did I take today?" -> {"subaction":"today","metric":null,"days":null,"shouldAct":true,"response":null}',
    '  "Show me my fitness trend this week" -> {"subaction":"trend","metric":null,"days":7,"shouldAct":true,"response":null}',
    '  "Tell me my heart rate" -> {"subaction":"by_metric","metric":"heart_rate","days":null,"shouldAct":true,"response":null}',
    '  "Is my health integration connected?" -> {"subaction":"status","metric":null,"days":null,"shouldAct":true,"response":null}',
    '  "¿Cuántos pasos di hoy?" -> {"subaction":"today","metric":null,"days":null,"shouldAct":true,"response":null}',
    "",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Structured parameters: ${JSON.stringify(args.params)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
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
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:health",
        error: error instanceof Error ? error.message : String(error),
      },
      "Health planning model call failed",
    );
    return {
      subaction: null,
      metric: null,
      days: null,
      shouldAct: null,
    };
  }
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

export const healthAction: Action = {
  name: "HEALTH",
  similes: [
    "FITNESS",
    "HEALTHKIT",
    "GOOGLE_FIT",
    "WELLNESS",
    "SLEEP",
    "SLEEP_DATA",
    "SLEEP_STATS",
    "STEPS",
    "STEP_COUNT",
    "HEART_RATE",
    "WORKOUT",
    "EXERCISE",
    "CALORIES",
    "ACTIVITY_METRICS",
  ],
  description:
    "Query health and fitness telemetry from HealthKit or Google Fit — sleep " +
    "(duration, quality, stages), steps, heart rate, workouts, calories, and " +
    "other body/activity metrics. Subactions: today, trend, by_metric, status. " +
    "Use this for questions like 'how did I sleep last night', 'how many steps " +
    "today', 'what was my resting heart rate', 'show my sleep trend this week'. " +
    "Do NOT route health-metric questions through LIFE (LIFE is for tasks/goals/" +
    "habits lifecycle, not wearable/quantified-self data).",
  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Health data is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const body = messageText(message);
    const explicitSubaction = normalizeHealthSubaction(params.subaction);
    let subaction: Subaction | null = explicitSubaction;
    let plannedMetric: HealthMetric | null = null;
    let plannedDays: number | null = null;
    if (!subaction) {
      const intent = (params.intent ?? body).trim();
      const plan = await resolveHealthPlanWithLlm({
        runtime,
        message,
        state,
        intent,
        params,
      });
      subaction = plan.subaction;
      plannedMetric = plan.metric;
      plannedDays = plan.days;
      if (plan.shouldAct === false || !subaction) {
        const text =
          plan.response ??
          "Tell me whether you want today's summary, a multi-day trend, a specific metric, or backend status.";
        await callback?.({ text });
        return {
          text,
          success: true,
          data: {
            noop: true,
            suggestedSubaction: subaction,
          },
        };
      }
    }
    const service = new LifeOpsService(runtime);
    const connectorStatus = await service.getHealthConnectorStatus();

    if (subaction === "status") {
      const text = connectorStatus.available
        ? `Health backend available: ${connectorStatus.backend}.`
        : "No health backend available. Set ELIZA_HEALTHKIT_CLI_PATH or ELIZA_GOOGLE_FIT_ACCESS_TOKEN.";
      await callback?.({ text, source: "action", action: "HEALTH" });
      return {
        text,
        success: true,
        data: { subaction, status: connectorStatus },
      };
    }

    // Graceful degradation: if no HealthKit/GoogleFit backend is configured,
    // surface a clear message instead of letting the health bridge throw.
    if (!connectorStatus.available) {
      const text =
        "I don't have a health data source connected yet. To share daily summaries, trends, or per-metric details, connect Apple Health (ELIZA_HEALTHKIT_CLI_PATH) or Google Fit (ELIZA_GOOGLE_FIT_ACCESS_TOKEN) and I'll pick it up.";
      await callback?.({ text, source: "action", action: "HEALTH" });
      return {
        text,
        success: true,
        data: {
          subaction,
          status: connectorStatus,
          degraded: "no-backend",
        },
      };
    }

    if (subaction === "trend") {
      const days =
        params.days && params.days > 0
          ? Math.floor(params.days)
          : (plannedDays ?? 7);
      const trend = await service.getHealthTrend(days);
      const text =
        trend.length === 0
          ? `No health data recorded in the last ${days} days.`
          : `Health trend (last ${days} days):\n${trend
              .map((s) => formatSummary(s))
              .join("\n\n")}`;
      await callback?.({ text, source: "action", action: "HEALTH" });
      return { text, success: true, data: { subaction, days, trend } };
    }

    if (subaction === "by_metric") {
      const metric =
        normalizeHealthMetric(params.metric) ?? plannedMetric;
      if (!metric) {
        const text =
          "Specify a metric: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.";
        await callback?.({ text, source: "action", action: "HEALTH" });
        return { text, success: false, data: { error: "MISSING_METRIC" } };
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
        const text =
          `No ${metric} data recorded in the last ${days} day${days === 1 ? "" : "s"}.`;
        await callback?.({ text, source: "action", action: "HEALTH" });
        return {
          text,
          success: true,
          data: { subaction, metric, startAt, endAt, points },
        };
      }
      const text =
        points.length === 0
          ? `No ${metric} data recorded in the last ${days} day${days === 1 ? "" : "s"}.`
          : `${metric} — last ${days} day${days === 1 ? "" : "s"}: total ${total.toFixed(
              2,
            )} ${firstPoint.unit} across ${points.length} sample${points.length === 1 ? "" : "s"}.`;
      await callback?.({ text, source: "action", action: "HEALTH" });
      return {
        text,
        success: true,
        data: { subaction, metric, startAt, endAt, points },
      };
    }

    // today — default
    const date = params.date ?? todayIso();
    const summary = await service.getHealthDailySummary(date);
    const text = `Health summary for ${formatSummary(summary)}`;
    await callback?.({ text, source: "action", action: "HEALTH" });
    return { text, success: true, data: { subaction: "today", date, summary } };
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which health query to run: today, trend, by_metric, status.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form user intent used to infer subaction when not explicitly set.",
      schema: { type: "string" as const },
    },
    {
      name: "metric",
      description:
        "Metric for by_metric queries: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.",
      schema: { type: "string" as const },
    },
    {
      name: "date",
      description: "YYYY-MM-DD for single-day queries.",
      schema: { type: "string" as const },
    },
    {
      name: "days",
      description: "Window size for trend and by_metric queries.",
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How many steps did I take today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Health summary for 2026-04-16 (healthkit):\n- Steps: 8,420 ...",
          action: "HEALTH",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my fitness trend this week." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Health trend (last 7 days): ...",
          action: "HEALTH",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Is my health integration connected?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Health backend available: healthkit.",
          action: "HEALTH",
        },
      },
    ],
  ] as ActionExample[][],
};
