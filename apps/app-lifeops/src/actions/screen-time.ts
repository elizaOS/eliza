/**
 * LifeOps screen time action — query per-app and per-website dwell time.
 *
 * Subactions: summary, today, weekly, weekly_average_by_app, by_app, by_website.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";
import { looksLikeScreenTimeReflection } from "./non-actionable-request.js";

type Subaction =
  | "summary"
  | "today"
  | "weekly"
  | "weekly_average_by_app"
  | "by_app"
  | "by_website";

type ScreenTimeParameters = {
  subaction?: Subaction;
  intent?: string;
  source?: "app" | "website";
  identifier?: string;
  date?: string;
  sinceDays?: number;
};

function getParams(options: HandlerOptions | undefined): ScreenTimeParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | ScreenTimeParameters
    | undefined;
  return params ?? {};
}

function messageText(message: Memory): string {
  return (message?.content?.text ?? "").toString().toLowerCase();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

function resolveWindowDays(value: number | undefined): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 7;
  return Math.max(1, Math.floor(raw));
}

export const screenTimeAction: Action = {
  name: "SCREEN_TIME",
  similes: ["SCREENTIME", "APP_USAGE", "WEBSITE_USAGE", "DWELL_TIME"],
  description:
    "Query screen time summaries (per app, per website, daily). Use this for quantitative usage questions like 'how much screen time have I used today?', 'break down my screen time by app this week', or 'which websites did I spend the most time on?'. Do not use this when the user is only reflecting or venting like 'I spend too much time on my phone' unless they actually ask for the numbers. Subactions: summary, today, weekly, weekly_average_by_app, by_app, by_website.",
  validate: async (runtime, message) => {
    if (looksLikeScreenTimeReflection(messageText(message))) {
      return false;
    }
    return hasLifeOpsAccess(runtime, message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Screen time data is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction: Subaction = params.subaction ?? "summary";
    const service = new LifeOpsService(runtime);

    if (subaction === "today") {
      const date = params.date ?? todayIso();
      const daily = await service.getScreenTimeDaily({
        date,
        source: params.source,
        limit: 10,
      });
      const total = daily.reduce((acc, row) => acc + row.totalSeconds, 0);
      const text =
        daily.length === 0
          ? `No screen time recorded for ${date}.`
          : `Screen time for ${date} (total ${formatSeconds(total)}):\n${daily
              .map(
                (row) =>
                  `- ${row.source}: ${row.identifier} — ${formatSeconds(row.totalSeconds)} (${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"})`,
              )
              .join("\n")}`;
      await callback?.({ text, source: "action", action: "SCREEN_TIME" });
      return { text, success: true, data: { subaction, date, daily } };
    }

    if (subaction === "weekly") {
      const until = new Date().toISOString();
      const since = daysAgoIso(params.sinceDays ?? 7);
      const summary = await service.getScreenTimeSummary({
        since,
        until,
        source: params.source,
        topN: 10,
      });
      const text =
        summary.items.length === 0
          ? `No screen time recorded in the last ${params.sinceDays ?? 7} days.`
          : `Top screen time over the last ${params.sinceDays ?? 7} days (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
              .map(
                (item) =>
                  `- ${item.source}: ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
              )
              .join("\n")}`;
      await callback?.({ text, source: "action", action: "SCREEN_TIME" });
      return {
        text,
        success: true,
        data: { subaction, since, until, summary },
      };
    }

    if (subaction === "weekly_average_by_app") {
      const daysInWindow = resolveWindowDays(params.sinceDays ?? 7);
      const until = new Date().toISOString();
      const since = daysAgoIso(daysInWindow);
      const weeklyAverage = await service.getScreenTimeWeeklyAverageByApp({
        since,
        until,
        daysInWindow,
      });
      const text =
        weeklyAverage.items.length === 0
          ? `No app screen time recorded in the last ${daysInWindow} days.`
          : `Weekly average per app over the last ${daysInWindow} days (total ${formatSeconds(weeklyAverage.totalSeconds)}):\n${weeklyAverage.items
              .map(
                (item) =>
                  `- ${item.displayName} — ${formatSeconds(item.averageSecondsPerDay)}/day average (${formatSeconds(item.totalSeconds)} total)`,
              )
              .join("\n")}`;
      await callback?.({ text, source: "action", action: "SCREEN_TIME" });
      return {
        text,
        success: true,
        data: { subaction, source: "app", since, until, weeklyAverage },
      };
    }

    if (subaction === "by_app" || subaction === "by_website") {
      const source = subaction === "by_app" ? "app" : "website";
      const until = new Date().toISOString();
      const since = daysAgoIso(params.sinceDays ?? 1);
      const summary = await service.getScreenTimeSummary({
        since,
        until,
        source,
        topN: 10,
      });
      const label = source === "app" ? "apps" : "websites";
      const text =
        summary.items.length === 0
          ? `No ${label} recorded in that window.`
          : `Top ${label} (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
              .map(
                (item) =>
                  `- ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
              )
              .join("\n")}`;
      await callback?.({ text, source: "action", action: "SCREEN_TIME" });
      return {
        text,
        success: true,
        data: { subaction, source, since, until, summary },
      };
    }

    // summary — default
    const until = new Date().toISOString();
    const since = daysAgoIso(params.sinceDays ?? 1);
    const summary = await service.getScreenTimeSummary({
      since,
      until,
      source: params.source,
      topN: 10,
    });
    const text =
      summary.items.length === 0
        ? "No screen time recorded in that window."
        : `Screen time summary (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
            .map(
              (item) =>
                `- ${item.source}: ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
            )
            .join("\n")}`;
    await callback?.({ text, source: "action", action: "SCREEN_TIME" });
    return {
      text,
      success: true,
      data: { subaction: "summary", since, until, summary },
    };
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which screen time query to run: summary, today, weekly, weekly_average_by_app, by_app, by_website.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form user intent used to infer subaction when not explicitly set.",
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description: "Restrict to 'app' or 'website'.",
      schema: { type: "string" as const },
    },
    {
      name: "identifier",
      description:
        "Specific app bundle id or website domain when filtering to a single source.",
      schema: { type: "string" as const },
    },
    {
      name: "date",
      description: "YYYY-MM-DD for 'today' / daily queries.",
      schema: { type: "string" as const },
    },
    {
      name: "sinceDays",
      description: "Number of days back from now for summary windows.",
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How much time did I spend on my computer today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Screen time for 2026-04-16 (total 3h 42m): ...",
          action: "SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What are my top apps this week?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Top screen time over the last 7 days (total 28h 10m): ...",
          action: "SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What's my weekly average per app?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Weekly average per app over the last 7 days (total 28h 10m): ...",
          action: "SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Which websites did I spend the most time on?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Top websites (total 5h 20m): ...",
          action: "SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show me a screen time summary." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Screen time summary (total 4h 08m): ...",
          action: "SCREEN_TIME",
        },
      },
    ],
  ],
};
