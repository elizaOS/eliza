/**
 * Reads a published project's Cloud analytics through its registry binding.
 *
 * The action never accepts an arbitrary app id as the primary identity: project
 * resolution happens first, then the durable `cloudAppId` selects the wire API.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import {
  readProjectAnalytics,
  readProjectAppIdentity,
} from "../cloud-response-validation.js";
import {
  projectOptionSources,
  projectResolutionMessage,
  resolveProject,
} from "../project-resolution.js";

const ACTION = "GET_APP_ANALYTICS";
const NO_KEY_MESSAGE =
  "Connect Eliza Cloud before asking for published-project analytics.";
const ERROR_MESSAGE =
  "I couldn't load that project's analytics from Eliza Cloud right now.";

interface AnalyticsIntent {
  period?: "hourly" | "daily" | "monthly";
  startDate?: string;
  endDate?: string;
}

function parseIntent(
  options: unknown,
): { ok: true; value: AnalyticsIntent } | { ok: false; message: string } {
  const source = projectOptionSources(options)[0];
  if (!source) return { ok: true, value: {} };
  const period = source.period;
  if (
    period !== undefined &&
    period !== "hourly" &&
    period !== "daily" &&
    period !== "monthly"
  ) {
    return {
      ok: false,
      message: "Analytics period must be hourly, daily, or monthly.",
    };
  }
  const readDate = (
    camel: string,
    snake: string,
  ): { value?: string; invalid?: true } => {
    const raw = source[camel] ?? source[snake];
    if (raw === undefined) return {};
    if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
      return { invalid: true };
    }
    return { value: new Date(raw).toISOString() };
  };
  const start = readDate("startDate", "start_date");
  const end = readDate("endDate", "end_date");
  if (start.invalid || end.invalid) {
    return {
      ok: false,
      message: "Analytics dates must be valid ISO dates.",
    };
  }
  if (
    start.value &&
    end.value &&
    Date.parse(start.value) > Date.parse(end.value)
  ) {
    return {
      ok: false,
      message: "Analytics startDate must not be after endDate.",
    };
  }
  return {
    ok: true,
    value: {
      ...(period ? { period } : {}),
      ...(start.value ? { startDate: start.value } : {}),
      ...(end.value ? { endDate: end.value } : {}),
    },
  };
}

export const getAppAnalyticsAction: Action = {
  name: ACTION,
  similes: [
    "GET_PROJECT_ANALYTICS",
    "PROJECT_ANALYTICS",
    "HOW_IS_MY_PROJECT_DOING",
    "PROJECT_TRAFFIC",
  ],
  description:
    "Read request, user, and credit-usage analytics for a published project. Resolves the active project by default and never mutates Cloud state.",
  descriptionCompressed: "Read analytics for a published project (read-only).",
  contexts: ["apps", "projects", "settings"],
  contextGate: { anyOf: ["apps", "projects", "settings"] },
  roleGate: { minRole: "ADMIN" },
  parameters: [
    {
      name: "project",
      description:
        "Optional project name or id. Omit to use the active project.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "period",
      description: "Analytics bucket size.",
      required: false,
      schema: { type: "string", enum: ["hourly", "daily", "monthly"] },
    },
    {
      name: "startDate",
      description: "Optional ISO start date.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "endDate",
      description: "Optional ISO end date.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const intent = parseIntent(options);
    if (!intent.ok) {
      await callback?.({ text: intent.message, actions: [ACTION] });
      return {
        success: false,
        text: "Invalid analytics window.",
        userFacingText: intent.message,
        data: { reason: "invalid_input" },
      };
    }

    try {
      const resolution = resolveProject(message, options);
      if (!resolution.project) {
        const reply = projectResolutionMessage(resolution);
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: "Project could not be resolved.",
          userFacingText: reply,
          data: { reason: resolution.reason },
        };
      }
      const project = resolution.project;
      if (!project.cloudAppId) {
        const reply = `"${project.name}" is not published yet, so it has no Cloud analytics.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: "Project has no Cloud binding.",
          userFacingText: reply,
          verifiedUserFacing: true,
          data: { reason: "not_published", projectId: project.id },
        };
      }

      const [appResponse, analyticsResponse] = await Promise.all([
        client.getApp(project.cloudAppId),
        client.getAppAnalytics(project.cloudAppId, intent.value),
      ]);
      const app = readProjectAppIdentity(appResponse, project.cloudAppId);
      const analytics = readProjectAnalytics(analyticsResponse);
      const totals = analytics.totalStats;
      const reply = [
        `"${project.name}" analytics (${analytics.period.type}, ${analytics.period.start} → ${analytics.period.end}):`,
        `• Requests: ${totals.totalRequests}`,
        `• Users: ${totals.totalUsers}`,
        `• Credits used: ${totals.totalCreditsUsed}`,
        `• Time-series buckets: ${analytics.analytics.length}`,
      ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Fetched analytics for ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          app: { id: app.id, name: app.name, slug: app.slug },
          analytics,
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error: err },
        "[GET_APP_ANALYTICS] Failed to read project analytics",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Failed to fetch project analytics.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};

export default getAppAnalyticsAction;
