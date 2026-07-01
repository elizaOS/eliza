/**
 * GET_APP_DEPLOY_STATUS — "is my app live? / what's the deploy status?".
 *
 * Resolves the app, reads `client.getAppDeployStatus(id)`, and formats the
 * public lifecycle (DRAFT / BUILDING / DEPLOYING / READY / ERROR) plus the URL.
 * Read-only.
 */

import type { AppDeployStatusResponse, AppDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  appUrl,
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can check your deploys.";
const NO_REFERENCE_MESSAGE =
  "Which app's deploy status would you like? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't check that deploy status right now — the Cloud API returned an error. Try again in a moment.";

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

/** Format the public deploy status into a human reply. */
export function formatDeployStatus(
  app: AppDto,
  statusRes: AppDeployStatusResponse,
): string {
  const raw = (statusRes.status ?? "").trim();
  const s = raw.toUpperCase();
  const url = statusRes.vercelUrl ?? appUrl(app);

  switch (s) {
    case "DRAFT":
      return `"${app.name}" hasn't been deployed yet (draft). Say "deploy ${app.name}" to ship it.`;
    case "BUILDING":
    case "DEPLOYING":
      return `"${app.name}" is building right now — I'll have a live URL once it finishes.`;
    case "READY":
    case "DEPLOYED":
      return url
        ? `"${app.name}" is live at ${url}.`
        : `"${app.name}" is deployed.`;
    case "ERROR":
    case "FAILED":
      return `"${app.name}"'s last deploy failed${
        statusRes.error ? `: ${statusRes.error}` : ""
      }. Want me to retry?`;
    default:
      return `"${app.name}" deploy status: ${raw || "unknown"}.`;
  }
}

export const getAppDeployStatusAction: Action = {
  name: "GET_APP_DEPLOY_STATUS",
  similes: [
    "IS_MY_APP_LIVE",
    "DEPLOY_STATUS",
    "APP_DEPLOY_STATUS",
    "IS_APP_DEPLOYED",
  ],
  description:
    "Report the deployment status of an Eliza Cloud app (draft / building / live / failed) and its URL. Use when the user asks whether an app is live, deployed, or done building.",
  descriptionCompressed:
    "Report an app's deploy status (draft/building/live/failed).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["GET_APP_DEPLOY_STATUS"],
      });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["GET_APP_DEPLOY_STATUS"],
      });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    try {
      const { app, available } = await resolveApp(client, reference);
      if (!app) {
        const msg = notFoundMessage(reference, available);
        await callback?.({ text: msg, actions: ["GET_APP_DEPLOY_STATUS"] });
        return {
          success: false,
          text: `No app matched "${reference}".`,
          userFacingText: msg,
          data: { reason: "not_found", reference },
        };
      }

      const statusRes = await client.getAppDeployStatus(app.id);
      const reply = formatDeployStatus(app, statusRes);
      await callback?.({ text: reply, actions: ["GET_APP_DEPLOY_STATUS"] });
      return {
        success: true,
        text: `Deploy status for ${app.name}: ${statusRes.status}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: app.id, name: app.name, slug: app.slug },
          status: statusRes.status,
          url: statusRes.vercelUrl ?? appUrl(app),
        },
      };
    } catch (err) {
      logger.warn(
        `[GET_APP_DEPLOY_STATUS] Failed for "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["GET_APP_DEPLOY_STATUS"],
      });
      return {
        success: false,
        text: "Failed to check deploy status.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "is my Acme Bot app live yet?" } },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" is live at https://acme.elizacloud.ai.',
          actions: ["GET_APP_DEPLOY_STATUS"],
        },
      },
    ],
  ],
};

export default getAppDeployStatusAction;
