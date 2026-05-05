/**
 * Activity tracker actions.
 *
 * GET_ACTIVITY_REPORT — per-app time breakdown for the last N hours.
 * GET_TIME_ON_APP      — time spent on a specific app (by name or bundle id).
 * GET_TIME_ON_SITE     — time spent on a specific site based on browser
 *                        activity reports pushed into the runtime store.
 *
 * Every user-visible reply runs through `renderLifeOpsActionReply` so the raw
 * data templates land in the agent's character voice. The structured `data`
 * payload on each ActionResult is preserved verbatim for downstream consumers.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isSupportedPlatform } from "@elizaos/native-activity-tracker";
import {
  getActivityReport,
  getTimeOnApp,
} from "../activity-profile/activity-tracker-reporting.js";
import { getBrowserDomainActivity } from "../lifeops/browser-extension-store.js";
import {
  messageText,
  renderLifeOpsActionReply,
} from "./lifeops-grounded-reply.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

type ActivityReportParams = { windowHours?: number };
type TimeOnAppParams = {
  appNameOrBundleId?: string;
  windowHours?: number;
};
type TimeOnSiteParams = { domain?: string; windowHours?: number };

function resolveWindowMs(windowHours: number | undefined): number {
  const raw =
    typeof windowHours === "number" && Number.isFinite(windowHours)
      ? windowHours
      : DEFAULT_WINDOW_HOURS;
  const clamped = Math.max(0.25, Math.min(MAX_WINDOW_HOURS, raw));
  return Math.round(clamped * 60 * 60 * 1000);
}

function getParameterRecord(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const parameters = options?.parameters;
  return parameters && typeof parameters === "object" ? parameters : {};
}

function getActivityReportParams(
  options: HandlerOptions | undefined,
): ActivityReportParams {
  const params = getParameterRecord(options);
  return {
    windowHours:
      typeof params.windowHours === "number" ? params.windowHours : undefined,
  };
}

function getTimeOnAppParams(
  options: HandlerOptions | undefined,
): TimeOnAppParams {
  const params = getParameterRecord(options);
  return {
    appNameOrBundleId:
      typeof params.appNameOrBundleId === "string"
        ? params.appNameOrBundleId
        : undefined,
    windowHours:
      typeof params.windowHours === "number" ? params.windowHours : undefined,
  };
}

function getTimeOnSiteParams(
  options: HandlerOptions | undefined,
): TimeOnSiteParams {
  const params = getParameterRecord(options);
  return {
    domain: typeof params.domain === "string" ? params.domain : undefined,
    windowHours:
      typeof params.windowHours === "number" ? params.windowHours : undefined,
  };
}

function formatMinutes(totalMs: number): number {
  return Math.round(totalMs / 60_000);
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return trimmed;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function buildReportSummary(
  apps: Array<{ appName: string; bundleId: string; totalMs: number }>,
): string {
  if (apps.length === 0) return "No app focus events recorded in that window.";
  return apps
    .slice(0, 10)
    .map(
      (app) =>
        `- ${app.appName || app.bundleId}: ${formatMinutes(app.totalMs)}m`,
    )
    .join("\n");
}

type RespondPayload<T extends NonNullable<ActionResult["data"]> | undefined> = {
  success: boolean;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  data?: T;
};

function makeRespond(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  callback: Parameters<NonNullable<Action["handler"]>>[4],
  actionName: string,
): <T extends NonNullable<ActionResult["data"]> | undefined>(
  payload: RespondPayload<T>,
) => Promise<ActionResult> {
  const intent = messageText(message).trim();
  return async (payload) => {
    const text = await renderLifeOpsActionReply({
      runtime,
      message,
      state,
      intent,
      scenario: payload.scenario,
      fallback: payload.fallback,
      context: payload.context,
    });
    await callback?.({ text, source: "action", action: actionName });
    return {
      text,
      success: payload.success,
      ...(payload.data ? { data: payload.data } : {}),
    };
  };
}

export const getActivityReportAction: Action = {
  name: "GET_ACTIVITY_REPORT",
  similes: ["ACTIVITY_REPORT", "WHAT_DID_I_WORK_ON", "TIME_TRACKING_REPORT"],
  description:
    "Per-app time breakdown for the last N hours (default 24h). Returns noDataReason='macos-only' on non-Darwin platforms.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const respond = makeRespond(
      runtime,
      message,
      state,
      callback,
      "GET_ACTIVITY_REPORT",
    );

    if (!(await hasLifeOpsAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Activity reports are restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }
    const params = getActivityReportParams(options);
    const windowMs = resolveWindowMs(params.windowHours);

    if (!isSupportedPlatform()) {
      return respond({
        success: true,
        scenario: "activity_report_unsupported_platform",
        fallback:
          "Activity tracking is macOS-only. No data available on this platform.",
        context: { windowMs },
        data: {
          apps: [],
          totalMs: 0,
          windowMs,
          noDataReason: "macos-only",
        },
      });
    }

    const agentId = String(runtime.agentId);
    const report = await getActivityReport(runtime, agentId, {
      windowMs,
      limit: 20,
    });
    const fallback = `Activity report (${formatMinutes(report.totalMs)}m total):\n${buildReportSummary(
      report.apps,
    )}`;
    return respond({
      success: true,
      scenario: "activity_report_summary",
      fallback,
      context: {
        totalMs: report.totalMs,
        appCount: report.apps.length,
        topApps: report.apps.slice(0, 5),
      },
      data: {
        sinceMs: report.sinceMs,
        untilMs: report.untilMs,
        totalMs: report.totalMs,
        apps: report.apps,
      },
    });
  },
  parameters: [
    {
      name: "windowHours",
      description:
        "Number of hours of history to report on (default 24, max 720).",
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      { name: "{{name1}}", content: { text: "What did I work on today?" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Activity report (312m total):\n- VS Code: 184m\n- Safari: 82m",
          action: "GET_ACTIVITY_REPORT",
        },
      },
    ],
  ],
};

export const getTimeOnAppAction: Action = {
  name: "GET_TIME_ON_APP",
  similes: ["TIME_IN_APP", "HOW_LONG_IN_APP"],
  description:
    "Time spent on a specific app (matched by app name or bundle id) over the last N hours.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const respond = makeRespond(
      runtime,
      message,
      state,
      callback,
      "GET_TIME_ON_APP",
    );

    if (!(await hasLifeOpsAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Activity reports are restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }
    const params = getTimeOnAppParams(options);
    const target = (params.appNameOrBundleId ?? "").trim();
    if (!target) {
      return respond({
        success: false,
        scenario: "time_on_app_missing_app",
        fallback: "Specify an app name or bundle id.",
        data: { error: "MISSING_APP" },
      });
    }
    const windowMs = resolveWindowMs(params.windowHours);

    if (!isSupportedPlatform()) {
      return respond({
        success: true,
        scenario: "time_on_app_unsupported_platform",
        fallback: `Activity tracking is macOS-only; no time-on-app data for ${target}.`,
        context: { app: target, windowMs },
        data: {
          minutes: 0,
          totalMs: 0,
          windowMs,
          app: target,
          noDataReason: "macos-only",
        },
      });
    }

    const agentId = String(runtime.agentId);
    const result = await getTimeOnApp(runtime, agentId, target, { windowMs });
    const minutes = formatMinutes(result.totalMs);
    const fallback =
      result.matchedBy === "none"
        ? `No focus events recorded for ${target} in that window.`
        : `${target}: ${minutes}m (matched by ${result.matchedBy}).`;
    return respond({
      success: true,
      scenario: "time_on_app",
      fallback,
      context: {
        app: target,
        minutes,
        matchedBy: result.matchedBy,
      },
      data: {
        app: target,
        minutes,
        totalMs: result.totalMs,
        matchedBy: result.matchedBy,
        windowMs,
      },
    });
  },
  parameters: [
    {
      name: "appNameOrBundleId",
      description:
        "App name (e.g. 'Safari') or bundle id (e.g. 'com.apple.Safari').",
      schema: { type: "string" as const },
    },
    {
      name: "windowHours",
      description: "Window in hours (default 24, max 720).",
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How long was I in VS Code today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "VS Code: 184m (matched by appName).",
          action: "GET_TIME_ON_APP",
        },
      },
    ],
  ],
};

export const getTimeOnSiteAction: Action = {
  name: "GET_TIME_ON_SITE",
  similes: ["TIME_ON_WEBSITE", "TIME_ON_DOMAIN"],
  description:
    "Time on a specific site based on browser activity reports pushed into the runtime store.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const respond = makeRespond(
      runtime,
      message,
      state,
      callback,
      "GET_TIME_ON_SITE",
    );

    if (!(await hasLifeOpsAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Activity reports are restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }
    const params = getTimeOnSiteParams(options);
    const rawDomain = (params.domain ?? "").trim();
    const domain = rawDomain ? normalizeDomain(rawDomain) : "";
    if (!domain) {
      return respond({
        success: false,
        scenario: "time_on_site_missing_domain",
        fallback: "Specify a site domain.",
        data: { error: "MISSING_DOMAIN" },
      });
    }
    const windowMs = resolveWindowMs(params.windowHours);
    const untilMs = Date.now();
    const sinceMs = untilMs - windowMs;
    const result = await getBrowserDomainActivity(runtime, {
      domain,
      sinceMs,
      untilMs,
    });
    const minutes = formatMinutes(result.totalMs);

    if (result.reportCount === 0) {
      logger.debug(
        { domain, windowMs },
        "[activity-tracker] GET_TIME_ON_SITE invoked before any browser activity reports were recorded.",
      );
      return respond({
        success: true,
        scenario: "time_on_site_no_browser_activity",
        fallback:
          "No browser activity reports have been received yet. Connect the LifeOps browser activity source and try again.",
        context: { domain, windowMs },
        data: {
          domain,
          minutes: 0,
          totalMs: 0,
          windowMs,
          noDataReason: "no-browser-activity-yet",
        },
      });
    }

    const fallback =
      result.totalMs > 0
        ? `${domain}: ${minutes}m.`
        : `No browser activity recorded for ${domain} in that window.`;
    return respond({
      success: true,
      scenario: "time_on_site",
      fallback,
      context: { domain, minutes, totalMs: result.totalMs },
      data: {
        domain,
        minutes,
        totalMs: result.totalMs,
        windowMs,
        ...(result.totalMs === 0 ? { noDataReason: "no-domain-activity" } : {}),
      },
    });
  },
  parameters: [
    {
      name: "domain",
      description: "Hostname (e.g. 'github.com').",
      schema: { type: "string" as const },
    },
    {
      name: "windowHours",
      description: "Window in hours (default 24, max 720).",
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "How long was I on github.com today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "github.com: 42m.",
          action: "GET_TIME_ON_SITE",
        },
      },
    ],
  ],
};
