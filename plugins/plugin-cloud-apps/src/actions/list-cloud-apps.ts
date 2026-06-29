/**
 * LIST_CLOUD_APPS — answer "what apps do I have on Eliza Cloud?".
 *
 * Reads the authenticated org's apps via the typed SDK (`client.listApps()`),
 * formats a clean reply (name / url / status), and handles the empty + no-key +
 * error paths gracefully. Read-only: no mutating calls.
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
  similes: [
    "MY_APPS",
    "GET_APPS",
    "WHAT_APPS_DO_I_HAVE",
    "MY_CLOUD_APPS",
    "LIST_APPS",
  ],
  description:
    "List the Eliza Cloud apps the user owns (name, URL, deployment status, and credits/earnings when present). Use when the user asks what apps they have, to see their apps, or to list their Cloud apps.",
  descriptionCompressed: "List the user's Eliza Cloud apps (name/url/status).",
  // Read-only inventory lookup; safe on any user turn.
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },

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
      logger.warn(
        `[LIST_CLOUD_APPS] Failed to list apps: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: false,
        text: "Failed to list Eliza Cloud apps.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "what apps do I have?" } },
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
