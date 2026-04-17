/**
 * LifeOps screen time action — query per-app and per-website dwell time.
 *
 * Subactions: summary, today, weekly, by_app, by_website.
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

type Subaction = "summary" | "today" | "weekly" | "by_app" | "by_website";

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

function inferSubaction(
  intent: string | undefined,
  messageBody: string,
): Subaction {
  const text = `${intent ?? ""} ${messageBody}`.toLowerCase();
  if (/\btoday\b/.test(text)) return "today";
  if (/\b(this week|weekly|past (7|seven) days|last week)\b/.test(text)) {
    return "weekly";
  }
  if (/\b(on|at|in|spent)\b.*\b(website|site|domain|url)\b/.test(text)) {
    return "by_website";
  }
  if (/\b(in|on|using|app)\b/.test(text) && /\b(app|application)\b/.test(text)) {
    return "by_app";
  }
  if (/\b(top|most used|top apps|top websites)\b/.test(text)) {
    return "summary";
  }
  return "summary";
}

export const screenTimeAction: Action = {
  name: "SCREEN_TIME",
  similes: ["SCREENTIME", "APP_USAGE", "WEBSITE_USAGE", "DWELL_TIME"],
  description:
    "Query screen time summaries (per app, per website, daily). Subactions: summary, today, weekly, by_app, by_website.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
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
    const body = messageText(message);
    const subaction = params.subaction ?? inferSubaction(params.intent, body);
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
        "Which screen time query to run: summary, today, weekly, by_app, by_website.",
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
