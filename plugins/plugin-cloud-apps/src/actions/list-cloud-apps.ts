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
  // "LIST_APPS" is deliberately NOT claimed: plugin-app-control's APP action
  // owns it for device-installed apps, and a simile claimed by two parents is
  // dropped from routing as ambiguous (#16561).
  similes: [
    "MY_APPS",
    "GET_APPS",
    "WHAT_APPS_DO_I_HAVE",
    "MY_CLOUD_APPS",
    "CLOUD_APPS",
    "LIST_ELIZA_CLOUD_APPS",
    "MY_DEPLOYED_APPS",
    "MY_SITES",
  ],
  description:
    "List the Eliza Cloud apps the user owns — the hosted apps and sites they created or deployed on Eliza Cloud (name, URL, deployment status, and credits/earnings when present). Use when the user asks what apps they have, to see their apps, their cloud apps, or the sites/apps they've made or deployed. Not for apps installed or running on this device.",
  descriptionCompressed:
    "List the user's Eliza Cloud apps (name/url/status); not locally installed apps.",
  routingHint:
    "The user's own Eliza Cloud apps -> LIST_CLOUD_APPS. 'List my apps', 'my cloud apps', 'what apps do I have on eliza cloud', 'sites/apps I've made or deployed' is LIST_CLOUD_APPS; apps installed or running on this device are APP (NOT this action).",
  // Read-only inventory lookup; safe on any user turn. "general" mirrors the
  // APP action's rationale (#9950): Stage-1 routinely classifies unambiguous
  // app asks ("list my cloud apps") as general context; without it this
  // action is context-gated off the planner surface and the local APP action
  // wins by forfeit.
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
        // The callback already delivered the complete configuration boundary
        // response. Stop this failed tool from asking an evaluator to add a
        // second, differently worded message.
        continueChain: false,
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
        // A single-operation read whose reply IS the complete answer: opting
        // into the gated evaluator skip keeps a small planner model from
        // re-rendering the already-delivered list as a second message.
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
        verifiedUserFacing: true,
        // The failure is already translated at this action boundary and sent
        // through the callback, so another planner pass can only double-post.
        continueChain: false,
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
