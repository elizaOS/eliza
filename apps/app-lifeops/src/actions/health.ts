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
} from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import type { HealthDataPoint } from "../lifeops/health-bridge.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

type Subaction = "today" | "trend" | "by_metric" | "status";

type HealthParameters = {
  subaction?: Subaction;
  intent?: string;
  metric?: HealthDataPoint["metric"];
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
  return (message?.content?.text ?? "").toString().toLowerCase();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function inferSubaction(
  intent: string | undefined,
  messageBody: string,
): Subaction {
  const text = `${intent ?? ""} ${messageBody}`.toLowerCase();
  if (/\b(status|connected|available|backend)\b/.test(text)) return "status";
  if (/\b(trend|past|last\s+\d+\s+days|week|weekly)\b/.test(text)) {
    return "trend";
  }
  if (/\b(steps|heart rate|sleep|calories|distance|active minutes)\b/.test(text)) {
    return "by_metric";
  }
  return "today";
}

function inferMetric(
  messageBody: string,
): HealthDataPoint["metric"] | undefined {
  if (/\bsteps?\b/.test(messageBody)) return "steps";
  if (/\bheart rate|bpm\b/.test(messageBody)) return "heart_rate";
  if (/\bsleep\b/.test(messageBody)) return "sleep_hours";
  if (/\bcalor/.test(messageBody)) return "calories";
  if (/\bdistance|miles|meters|km\b/.test(messageBody)) return "distance_meters";
  if (/\bactive minutes|active time\b/.test(messageBody)) return "active_minutes";
  return undefined;
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
  similes: ["FITNESS", "HEALTHKIT", "GOOGLE_FIT", "WELLNESS"],
  description:
    "Query health and fitness data from HealthKit or Google Fit. Subactions: today, trend, by_metric, status.",
  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
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
    const subaction = params.subaction ?? inferSubaction(params.intent, body);
    const service = new LifeOpsService(runtime);

    if (subaction === "status") {
      const status = await service.getHealthConnectorStatus();
      const text = status.available
        ? `Health backend available: ${status.backend}.`
        : "No health backend available. Set ELIZA_HEALTHKIT_CLI_PATH or ELIZA_GOOGLE_FIT_ACCESS_TOKEN.";
      await callback?.({ text, source: "action", action: "HEALTH" });
      return { text, success: true, data: { subaction, status } };
    }

    if (subaction === "trend") {
      const days = params.days && params.days > 0 ? Math.floor(params.days) : 7;
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
      const metric = params.metric ?? inferMetric(body);
      if (!metric) {
        const text =
          "Specify a metric: steps, active_minutes, sleep_hours, heart_rate, calories, distance_meters.";
        await callback?.({ text, source: "action", action: "HEALTH" });
        return { text, success: false, data: { error: "MISSING_METRIC" } };
      }
      const days = params.days && params.days > 0 ? Math.floor(params.days) : 1;
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
      const text =
        points.length === 0
          ? `No ${metric} data recorded in the last ${days} day${days === 1 ? "" : "s"}.`
          : `${metric} — last ${days} day${days === 1 ? "" : "s"}: total ${total.toFixed(
              2,
            )} ${points[0].unit} across ${points.length} sample${points.length === 1 ? "" : "s"}.`;
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
