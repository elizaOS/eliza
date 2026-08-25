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
import { formatAppLine, getCloudClient } from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY (from cloud.eliza.app → dashboard → API keys) and I can list your apps.";
const EMPTY_MESSAGE =
  "You haven't created any apps on Eliza Cloud yet. You can build one from the Apps view or just ask me to create an app.";
const ERROR_MESSAGE =
  "I couldn't fetch your Eliza Cloud apps right now — the Cloud API returned an error. Try again in a moment.";

export const listCloudAppsAction: Action = {
  name: "LIST_CLOUD_APPS",
  // "LIST_APPS" is deliberately NOT claimed: plugin-app-control's APP action
  // owns it for device-installed apps, and a simile claimed by two parents is
  // dropped from routing as ambiguous (#16561). Generic aliases (MY_APPS,
  // GET_APPS, WHAT_APPS_DO_I_HAVE) are likewise NOT claimed (#17363): generic
  // installed-app language belongs to the local APP action, and every alias
  // here must carry an explicit cloud/deployed/hosted qualifier.
  similes: [
    "MY_CLOUD_APPS",
    "CLOUD_APPS",
    "LIST_ELIZA_CLOUD_APPS",
    "MY_DEPLOYED_APPS",
    "MY_HOSTED_APPS",
  ],
  description:
    "List the Eliza Cloud apps the user owns — the hosted apps and sites they created or deployed on Eliza Cloud (name, URL, deployment status, and credits/earnings when present). Use when the user explicitly asks about their cloud, hosted, or deployed apps/sites. Not for apps installed or running on this device — a generic 'what apps do I have' is the local installed-app inventory.",
  descriptionCompressed:
    "List the user's Eliza Cloud apps (name/url/status); not locally installed apps.",
  routingHint:
    "The user's own Eliza Cloud apps -> LIST_CLOUD_APPS. 'List my cloud apps', 'what apps do I have on eliza cloud', 'my deployed/hosted apps or sites' is LIST_CLOUD_APPS; generic app asks and apps installed or running on this device are APP (NOT this action).",
  // Read-only inventory lookup; safe on any user turn. "general" mirrors the
  // APP action's rationale (#9950): Stage-1 routinely classifies unambiguous
  // app asks ("list my cloud apps") as general context; without it this
  // action is context-gated off the planner surface and the local APP action
  // wins by forfeit.
  contexts: ["settings", "finance", "apps", "general"],
  contextGate: { anyOf: ["settings", "finance", "apps", "general"] },

  // Deliberately unconditional. Gating on the Cloud key removed this read from
  // the action catalog whenever the key was missing, so a cloud-qualified ask
  // fell through to the local installed-app action or to a generic "I can't do
  // that" — the user never learned WHY. Keeping the action reachable lets the
  // handler below own the truthful configured-capability failure and deliver it
  // once, which is the outcome #17363 requires on the public planner path.
  validate: async (): Promise<boolean> => true,

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
      // Verified terminal failure: the message above IS the complete honest
      // outcome, so the evaluator must not paraphrase it into a second reply
      // (#17363). success stays false.
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { reason: "no_key" },
      };
    }

    let response: Awaited<ReturnType<typeof client.listApps>>;
    // error-policy:J1 The action boundary translates only the Cloud request;
    // connector delivery remains owned by the caller and must reject unchanged.
    try {
      response = await client.listApps();
    } catch (err) {
      logger.warn({ err }, "[LIST_CLOUD_APPS] Failed to list apps");
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: false,
        text: "Failed to list Eliza Cloud apps.",
        userFacingText: ERROR_MESSAGE,
        // Verified terminal failure — one canonical reply, success stays false
        // (#17363).
        verifiedUserFacing: true,
        turnComplete: true,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    const { apps } = response;
    if (!apps || apps.length === 0) {
      await callback?.({ text: EMPTY_MESSAGE, actions: ["LIST_CLOUD_APPS"] });
      return {
        success: true,
        text: "User has no Eliza Cloud apps.",
        userFacingText: EMPTY_MESSAGE,
        // The verified empty inventory IS the complete answer; without the
        // terminal stamp the evaluator paraphrased it into a second bubble
        // (#17363).
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
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "what apps do I have on eliza cloud?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "You have 2 apps on Eliza Cloud:\n• Acme Bot — https://acme.apps.eliza.app — deployed\n• Side Project — https://side.example.com — draft",
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
