/**
 * OWNER_SCREEN_TIME — Tier 2-E umbrella.
 *
 * Collapses screen-time + activity-tracker queries into a single owner-only
 * action dispatched by a required `subaction` parameter. Routes to the
 * existing handlers in screen-time.ts and activity-report.ts.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { extractActionParamsViaLlm } from "@elizaos/agent";
import { screenTimeAction } from "./screen-time.js";
import {
  getActivityReportAction,
  getTimeOnAppAction,
  getTimeOnSiteAction,
} from "./activity-report.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

const ACTION_NAME = "OWNER_SCREEN_TIME";

type ScreenTimeSub =
  | "summary"
  | "today"
  | "weekly"
  | "weekly_average_by_app"
  | "by_app"
  | "by_website";
type ActivitySub = "activity_report" | "time_on_app" | "time_on_site";
type Subaction = ScreenTimeSub | ActivitySub;

const SCREEN_TIME_SUBS: ReadonlySet<string> = new Set<ScreenTimeSub>([
  "summary",
  "today",
  "weekly",
  "weekly_average_by_app",
  "by_app",
  "by_website",
]);

const ACTIVITY_SUBS: ReadonlySet<string> = new Set<ActivitySub>([
  "activity_report",
  "time_on_app",
  "time_on_site",
]);

interface OwnerScreenTimeParameters {
  subaction?: Subaction | string;
  intent?: string;
  // screen-time params
  source?: "app" | "website";
  identifier?: string;
  date?: string;
  sinceDays?: number;
  // activity-report params
  windowHours?: number;
  appNameOrBundleId?: string;
  domain?: string;
}

function coerceSubaction(value: unknown): Subaction | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.trim().toLowerCase();
  if (SCREEN_TIME_SUBS.has(n) || ACTIVITY_SUBS.has(n)) {
    return n as Subaction;
  }
  return undefined;
}

export const ownerScreenTimeAction: Action = {
  name: ACTION_NAME,
  similes: [
    "SCREEN_TIME",
    "SCREENTIME",
    "APP_USAGE",
    "WEBSITE_USAGE",
    "DWELL_TIME",
    "GET_ACTIVITY_REPORT",
    "ACTIVITY_REPORT",
    "WHAT_DID_I_WORK_ON",
    "GET_TIME_ON_APP",
    "TIME_IN_APP",
    "GET_TIME_ON_SITE",
    "TIME_ON_WEBSITE",
  ],
  description:
    "Owner-only. Quantitative screen-time and activity analytics. " +
    "Subactions: summary (default rolling window), today (per-day breakdown), weekly (last N days, default 7), " +
    "weekly_average_by_app (average per app per day across the window), " +
    "by_app (top apps by dwell time), by_website (top websites by dwell time), " +
    "activity_report (per-app focus minutes from macOS native tracker for the last N hours), " +
    "time_on_app (focus time for one specific app name or bundle id), " +
    "time_on_site (browser time on one specific domain from browser-activity reports). " +
    "Use this ONLY for quantitative usage questions like 'how much time did I spend today?' or 'top apps this week'. " +
    "Do not use it for reflective/venting messages like 'I spend too much time on my phone' unless the owner explicitly asks for numbers. " +
    "Do NOT use it to block apps or websites (OWNER_APP_BLOCK / OWNER_WEBSITE_BLOCK) or to start remote sessions (OWNER_REMOTE_DESKTOP).",

  validate: async (runtime, message) => {
    return hasLifeOpsAccess(runtime, message);
  },

  parameters: [
    {
      name: "subaction",
      description:
        "One of: summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site. Strongly preferred — when omitted, the handler runs an LLM extraction over the conversation to recover it.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description: "Free-form user intent string (logged, not used for dispatch).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description: "Restrict screen-time subactions to 'app' or 'website'.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "identifier",
      description:
        "Specific app bundle id or website domain when filtering screen-time to one source.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "date",
      description: "YYYY-MM-DD for the today subaction.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sinceDays",
      description:
        "Number of days back from now for screen-time summary/weekly windows.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "windowHours",
      description:
        "Window in hours for activity_report / time_on_app / time_on_site (default 24, max 720).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "appNameOrBundleId",
      description:
        "App name (e.g. 'Safari') or bundle id (e.g. 'com.apple.Safari') for time_on_app.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "domain",
      description: "Hostname (e.g. 'github.com') for time_on_site.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How much screen time did I use today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Screen time for 2026-04-19 (total 3h 42m): ...",
          action: "OWNER_SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What did I work on in the last 8 hours?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Activity report (312m total): ...",
          action: "OWNER_SCREEN_TIME",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "How long was I on github.com today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "github.com: 42m.",
          action: "OWNER_SCREEN_TIME",
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
          action: "OWNER_SCREEN_TIME",
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Screen time data is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as OwnerScreenTimeParameters;
    const params = (await extractActionParamsViaLlm<OwnerScreenTimeParameters & Record<string, unknown>>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: ownerScreenTimeAction.description ?? "",
      paramSchema: ownerScreenTimeAction.parameters ?? [],
      existingParams: rawParams as Record<string, unknown>,
      requiredFields: ["subaction"],
    })) as OwnerScreenTimeParameters;
    const subaction = coerceSubaction(params.subaction);
    if (!subaction) {
      const text =
        "Missing or invalid subaction. Use one of: summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site.";
      await callback?.({ text });
      return {
        text,
        success: false,
        data: { error: "INVALID_SUBACTION" },
      };
    }

    if (SCREEN_TIME_SUBS.has(subaction)) {
      return (await screenTimeAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }

    if (subaction === "activity_report") {
      return (await getActivityReportAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "time_on_app") {
      return (await getTimeOnAppAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    return (await getTimeOnSiteAction.handler!(
      runtime,
      message,
      state,
      options,
      callback,
    )) as ActionResult;
  },
};
