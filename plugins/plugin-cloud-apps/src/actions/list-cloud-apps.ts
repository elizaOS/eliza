/**
 * Lists an authenticated organization's Eliza Cloud apps for cloud-inventory turns.
 *
 * The canonical result text owns the sole-operation response across callback
 * and returned-result transports, including empty and API failure states.
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
import {
  formatAppLine,
  getCloudClient,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY (from elizacloud.ai → dashboard → API keys) and I can list your apps.";
const EMPTY_MESSAGE =
  "You haven't created any apps on Eliza Cloud yet. You can build one from the Apps view or just ask me to create an app.";
const ERROR_MESSAGE =
  "I couldn't fetch your Eliza Cloud apps right now — the Cloud API returned an error. Try again in a moment.";

export const listCloudAppsAction: Action = {
  name: "LIST_CLOUD_APPS",
  // "LIST_APPS" is deliberately NOT claimed: plugin-app-control's APP action
  // owns it for device-installed apps, and a simile claimed by two parents is
  // dropped from routing as ambiguous (#16561).
  similes: [
    "MY_CLOUD_APPS",
    "CLOUD_APPS",
    "LIST_ELIZA_CLOUD_APPS",
    "MY_DEPLOYED_APPS",
    "MY_HOSTED_APPS",
    "MY_SITES",
  ],
  description:
    "List the hosted apps and sites the user created or deployed on Eliza Cloud (name, URL, deployment status, and credits/earnings when present). Use only for cloud-qualified inventory requests, not an individual app operation or apps installed on this device.",
  descriptionCompressed:
    "List the user's Eliza Cloud apps (name/url/status); not locally installed apps.",
  routingHint:
    "Cloud-qualified inventory requests such as 'list my cloud apps', 'what apps do I have on Eliza Cloud', or 'sites I deployed' -> LIST_CLOUD_APPS. A launch, deploy, create, delete, update, or compound request uses the corresponding cloud-app action instead. Apps installed or running on this device use APP.",
  // Stage 1 classifies explicit cloud inventory asks as general context, while
  // settings/finance/apps cover turns already narrowed to cloud management.
  contexts: ["settings", "finance", "apps", "general"],
  contextGate: { anyOf: ["settings", "finance", "apps", "general"] },

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { reason: "no_key" },
      };
    }

    try {
      const { apps } = await client.listApps();

      if (!apps || apps.length === 0) {
        await callback?.({ text: EMPTY_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
        return {
          success: true,
          text: "User has no Eliza Cloud apps.",
          userFacingText: EMPTY_MESSAGE,
          verifiedUserFacing: true,
          turnComplete: true,
          data: { count: 0, apps: [] },
        };
      }

      const header =
        apps.length === 1
          ? "You have 1 app on Eliza Cloud:"
          : `You have ${apps.length} apps on Eliza Cloud:`;
      const body = apps.map(formatAppLine).join("\n");
      const reply = `${header}\n${body}`;

      await callback?.({ text: reply, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: true,
        text: `Listed ${apps.length} Eliza Cloud app(s).`,
        userFacingText: reply,
        verifiedUserFacing: true,
        turnComplete: true,
        data: {
          count: apps.length,
          apps: apps.map((a) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
            status: a.deployment_status,
          })),
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary translation — the SDK failure becomes
      // the complete retry guidance for this single read operation.
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "[LIST_CLOUD_APPS] Failed to list apps",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: false,
        text: "Failed to list Eliza Cloud apps.",
        userFacingText: ERROR_MESSAGE,
        verifiedUserFacing: true,
        turnComplete: true,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "what apps do I have on Eliza Cloud?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "You have 2 apps on Eliza Cloud:\n• Acme Bot — https://acme.elizacloud.ai — deployed\n• Side Project — https://side.example.com — draft",
          actions: ["LIST_CLOUD_APPS"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "list my cloud apps" } },
      {
        name: "{{agent}}",
        content: {
          text: "You haven't created any apps on Eliza Cloud yet.",
          actions: ["LIST_CLOUD_APPS"],
        },
      },
    ],
  ],
};

export default listCloudAppsAction;
