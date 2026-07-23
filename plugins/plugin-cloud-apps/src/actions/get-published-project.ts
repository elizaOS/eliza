/**
 * Reads the complete live publication state for one local Project.
 *
 * The registry owns only the binding; Cloud remains authoritative for active
 * state, hosting URL, analytics, and earnings. The action therefore fetches
 * every field live and reports an active row without a verified URL as an
 * error, never as a healthy published state.
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
  readProjectEarnings,
  readProjectFrontendState,
  readProjectPublicationApp,
} from "../cloud-response-validation.js";
import {
  projectResolutionMessage,
  resolveProject,
} from "../project-resolution.js";

const ACTION = "GET_PUBLISHED_PROJECT";
const NO_KEY_MESSAGE =
  "Connect Eliza Cloud before checking a project's publication.";
const ERROR_MESSAGE =
  "I couldn't load that project's publication state from Eliza Cloud right now.";

function cleanUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname === "placeholder.invalid" ||
      parsed.hostname === "pending.invalid"
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // error-policy:J3 malformed Cloud URL is an explicit non-live signal.
    return null;
  }
}

export const getPublishedProjectAction: Action = {
  name: ACTION,
  similes: [
    "GET_PROJECT_PUBLICATION",
    "PROJECT_PUBLICATION_STATUS",
    "IS_MY_PROJECT_PUBLISHED",
    "HOW_IS_MY_PROJECT_DOING",
  ],
  description:
    "Show whether a local project is published, its authoritative public URL and Cloud status, plus top-line analytics and earnings. Defaults to the active project.",
  descriptionCompressed:
    "Get a project's live publication, analytics, and earnings state.",
  contexts: ["apps", "projects", "settings", "finance"],
  contextGate: { anyOf: ["apps", "projects", "settings", "finance"] },
  roleGate: { minRole: "ADMIN" },
  parameters: [
    {
      name: "project",
      description:
        "Optional project name or id. Omit to use the active project.",
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
        const reply = `"${project.name}" is local only — it has not been published to Eliza Cloud.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `Project ${project.name} is not published.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            project: { id: project.id, name: project.name },
            published: false,
            state: "unbound",
          },
        };
      }

      const [
        appResponse,
        frontendResponse,
        analyticsResponse,
        earningsResponse,
      ] = await Promise.all([
        client.getApp(project.cloudAppId),
        client.listAppFrontendDeployments(project.cloudAppId),
        client.getAppAnalytics(project.cloudAppId),
        client.getAppEarnings(project.cloudAppId),
      ]);
      const app = readProjectPublicationApp(appResponse, project.cloudAppId);
      const frontend = readProjectFrontendState(
        frontendResponse,
        project.cloudAppId,
      );
      const analytics = readProjectAnalytics(analyticsResponse);
      const activeFrontend = frontend.activeDeploymentId
        ? frontend.deployments.find(
            (deployment) =>
              deployment.id === frontend.activeDeploymentId &&
              deployment.status === "active",
          )
        : null;
      const managedUrl = activeFrontend ? cleanUrl(frontend.publicUrl) : null;
      const containerUrl =
        app.deploymentStatus === "deployed"
          ? cleanUrl(app.productionUrl)
          : null;
      const publicUrl = managedUrl ?? containerUrl;
      const earnings = readProjectEarnings(earningsResponse);
      const published = app.isActive && publicUrl !== null;

      if (app.isActive && !publicUrl) {
        const reply = `"${project.name}" has an active Cloud record, but Cloud did not return a live managed-frontend or container URL. It is not safe to call this project published.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: `Project ${project.name} is active without a live URL.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            reason: "active_without_live_url",
            project: {
              id: project.id,
              name: project.name,
              cloudAppId: project.cloudAppId,
            },
            published: false,
            state: "error",
            analytics: analytics.totalStats,
            earnings,
          },
        };
      }

      const reply = published
        ? [
            `"${project.name}" is published at ${publicUrl}.`,
            `• Cloud status: ${app.deploymentStatus}`,
            `• Requests: ${analytics.totalStats.totalRequests}`,
            `• Users: ${analytics.totalStats.totalUsers}`,
            `• Lifetime earnings: ${earnings ? `$${earnings.totalLifetimeEarnings.toFixed(2)}` : "No earnings record yet"}`,
            `• Withdrawable: ${earnings ? `$${earnings.withdrawableBalance.toFixed(2)}` : "No earnings record yet"}`,
          ].join("\n")
        : [
            `"${project.name}" is currently unpublished; its Cloud record and project binding are preserved.`,
            `• Requests: ${analytics.totalStats.totalRequests}`,
            `• Users: ${analytics.totalStats.totalUsers}`,
            `• Lifetime earnings: ${earnings ? `$${earnings.totalLifetimeEarnings.toFixed(2)}` : "No earnings record yet"}`,
          ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Fetched publication state for ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          app: {
            id: app.id,
            name: app.name,
            slug: app.slug,
            isActive: app.isActive,
            deploymentStatus: app.deploymentStatus,
          },
          published,
          state: published ? "published" : "unpublished",
          publicUrl,
          hosting: managedUrl
            ? "managed-frontend"
            : containerUrl
              ? "container"
              : null,
          analytics: analytics.totalStats,
          earnings,
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error: err },
        "[GET_PUBLISHED_PROJECT] Failed to read project publication",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Failed to fetch project publication.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};

export default getPublishedProjectAction;
