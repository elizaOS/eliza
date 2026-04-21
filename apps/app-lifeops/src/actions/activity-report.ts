/**
 * Activity tracker actions.
 *
 * GET_ACTIVITY_REPORT — per-app time breakdown for the last N hours.
 * GET_TIME_ON_APP      — time spent on a specific app (by name or bundle id).
 * GET_TIME_ON_SITE     — time spent on a specific site based on browser
 *                        activity reports pushed into the runtime store.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isSupportedPlatform } from "@elizaos/native-activity-tracker";
import {
  getActivityReport,
  getTimeOnApp,
} from "../activity-profile/activity-tracker-reporting.js";
import { getBrowserDomainActivity } from "../lifeops/browser-extension-store.js";
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

export const getActivityReportAction: Action = {
  name: "GET_ACTIVITY_REPORT",
  similes: ["ACTIVITY_REPORT", "WHAT_DID_I_WORK_ON", "TIME_TRACKING_REPORT"],
  description:
    "Per-app time breakdown for the last N hours (default 24h). Returns noDataReason='macos-only' on non-Darwin platforms.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Activity reports are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const params = getActivityReportParams(options);
    const windowMs = resolveWindowMs(params.windowHours);

    if (!isSupportedPlatform()) {
      const text =
        "Activity tracking is macOS-only. No data available on this platform.";
      await callback?.({
        text,
        source: "action",
        action: "GET_ACTIVITY_REPORT",
      });
      return {
        text,
        success: true,
        data: {
          apps: [],
          totalMs: 0,
          windowMs,
          noDataReason: "macos-only",
        },
      };
    }

    const agentId = String(runtime.agentId);
    const report = await getActivityReport(runtime, agentId, {
      windowMs,
      limit: 20,
    });
    const text = `Activity report (${formatMinutes(report.totalMs)}m total):\n${buildReportSummary(
      report.apps,
    )}`;
    await callback?.({ text, source: "action", action: "GET_ACTIVITY_REPORT" });
    return {
      text,
      success: true,
      data: {
        sinceMs: report.sinceMs,
        untilMs: report.untilMs,
        totalMs: report.totalMs,
        apps: report.apps,
      },
    };
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
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Activity reports are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const params = getTimeOnAppParams(options);
    const target = (params.appNameOrBundleId ?? "").trim();
    if (!target) {
      const text = "Specify an app name or bundle id.";
      await callback?.({ text });
      return {
        text,
        success: false,
        data: { error: "MISSING_APP" },
      };
    }
    const windowMs = resolveWindowMs(params.windowHours);

    if (!isSupportedPlatform()) {
      const text = `Activity tracking is macOS-only; no time-on-app data for ${target}.`;
      await callback?.({ text, source: "action", action: "GET_TIME_ON_APP" });
      return {
        text,
        success: true,
        data: {
          minutes: 0,
          totalMs: 0,
          windowMs,
          app: target,
          noDataReason: "macos-only",
        },
      };
    }

    const agentId = String(runtime.agentId);
    const result = await getTimeOnApp(runtime, agentId, target, { windowMs });
    const minutes = formatMinutes(result.totalMs);
    const text =
      result.matchedBy === "none"
        ? `No focus events recorded for ${target} in that window.`
        : `${target}: ${minutes}m (matched by ${result.matchedBy}).`;
    await callback?.({ text, source: "action", action: "GET_TIME_ON_APP" });
    return {
      text,
      success: true,
      data: {
        app: target,
        minutes,
        totalMs: result.totalMs,
        matchedBy: result.matchedBy,
        windowMs,
      },
    };
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
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Activity reports are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const params = getTimeOnSiteParams(options);
    const rawDomain = (params.domain ?? "").trim();
    const domain = rawDomain ? normalizeDomain(rawDomain) : "";
    if (!domain) {
      const text = "Specify a site domain.";
      await callback?.({ text });
      return { text, success: false, data: { error: "MISSING_DOMAIN" } };
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
      const text =
        "No browser activity reports have been received yet. Connect the LifeOps browser activity source and try again.";
      logger.debug(
        { domain, windowMs },
        "[activity-tracker] GET_TIME_ON_SITE invoked before any browser activity reports were recorded.",
      );
      await callback?.({ text, source: "action", action: "GET_TIME_ON_SITE" });
      return {
        text,
        success: true,
        data: {
          domain,
          minutes: 0,
          totalMs: 0,
          windowMs,
          noDataReason: "no-browser-activity-yet",
        },
      };
    }

    const text =
      result.totalMs > 0
        ? `${domain}: ${minutes}m.`
        : `No browser activity recorded for ${domain} in that window.`;
    await callback?.({ text, source: "action", action: "GET_TIME_ON_SITE" });
    return {
      text,
      success: true,
      data: {
        domain,
        minutes,
        totalMs: result.totalMs,
        windowMs,
        ...(result.totalMs === 0 ? { noDataReason: "no-domain-activity" } : {}),
      },
    };
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
