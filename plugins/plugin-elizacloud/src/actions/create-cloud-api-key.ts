/**
 * CLOUD_CREATE_API_KEY — mint a new Eliza Cloud API key from chat.
 *
 * The upstream route (`POST /api/v1/api-keys`) is session-only — an `eliza_`
 * org API key cannot mint API keys — so when the SDK call is rejected with
 * 401/403 the action replies honestly with a pointer to the in-app Cloud view
 * and the console, where the user's signed-in session CAN create keys. On
 * success the plain key is surfaced exactly once (it is never retrievable
 * again) and never logged. Names with the reserved `agent-sandbox:` prefix
 * are refused before any network call.
 */

import { CloudApiError } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { invalidateCloudAccountCache } from "../cloud-providers/cloud-account";
import { createElizaCloudClient } from "../utils/sdk-client";
import { cloudAccountAuthenticated, NO_CLOUD_MESSAGE } from "./cloud-account-status";

const RESERVED_PREFIX = "agent-sandbox:";
const SESSION_REQUIRED_MESSAGE =
  "Eliza Cloud only allows API keys to be created from a signed-in session — my agent credential can't mint them. Open the Cloud app in the launcher (or the console at elizacloud.ai → dashboard → API keys) to create one.";
const ERROR_MESSAGE =
  "I couldn't create the API key right now — the Cloud API returned an error. Try again in a moment.";

/**
 * Pull a key name out of the message: a quoted string first, then the word
 * after "named"/"called". Falls back to a dated default so the action never
 * blocks on a missing name.
 */
export function parseApiKeyName(text: string, now = new Date()): string {
  // Per-quote alternation so the delimiters must MATCH (`"ci-deploys'` is not
  // a quoted name); curly quotes pair with their curly counterparts.
  const quoted = text.match(/"([^"]{1,64})"|'([^']{1,64})'|“([^”]{1,64})”/);
  const quotedName = quoted?.[1] ?? quoted?.[2] ?? quoted?.[3];
  if (quotedName?.trim()) return quotedName.trim();
  const named = text.match(/\b(?:named|called)\s+([\w][\w./-]{0,63})/i);
  if (named?.[1]) return named[1];
  return `agent-created-${now.toISOString().slice(0, 10)}`;
}

export const createCloudApiKeyAction: Action = {
  name: "CLOUD_CREATE_API_KEY",
  similes: ["NEW_CLOUD_API_KEY", "MAKE_API_KEY", "CREATE_API_KEY"],
  description:
    "Create a new Eliza Cloud API key with an optional name. Use when the user asks to create, generate, or mint a cloud API key. The plain key is shown once and must be copied immediately.",
  descriptionCompressed: "Create a new Eliza Cloud API key.",
  contexts: ["cloud", "settings"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    cloudAccountAuthenticated(runtime),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!cloudAccountAuthenticated(runtime)) {
      await callback?.({ text: NO_CLOUD_MESSAGE, actions: ["CLOUD_CREATE_API_KEY"] });
      return {
        success: false,
        text: "Not connected to Eliza Cloud.",
        userFacingText: NO_CLOUD_MESSAGE,
        data: { reason: "not_connected" },
      };
    }

    const name = parseApiKeyName(message.content?.text ?? "");
    if (name.toLowerCase().startsWith(RESERVED_PREFIX)) {
      const reserved = `Key names starting with "${RESERVED_PREFIX}" are reserved for provisioner-managed keys — pick another name.`;
      await callback?.({ text: reserved, actions: ["CLOUD_CREATE_API_KEY"] });
      return {
        success: false,
        text: "Requested API key name uses the reserved agent-sandbox: prefix.",
        userFacingText: reserved,
        data: { reason: "reserved_name", name },
      };
    }

    try {
      const { apiKey, plainKey } = await createElizaCloudClient(runtime).createApiKey({
        name,
      });
      invalidateCloudAccountCache(runtime);

      const reply = [
        `Created Eliza Cloud API key "${apiKey.name}".`,
        "",
        plainKey,
        "",
        "Copy it now — this is the only time the full key is shown. Manage or revoke it from the console (elizacloud.ai → dashboard → API keys).",
      ].join("\n");

      await callback?.({ text: reply, actions: ["CLOUD_CREATE_API_KEY"] });
      // The plain key transits ONLY the user-facing reply; the durable action
      // result carries the redacted summary so logs/trajectories never hold it.
      return {
        success: true,
        text: `Created Eliza Cloud API key "${apiKey.name}" (${apiKey.key_prefix}…).`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.key_prefix },
      };
    } catch (err) {
      if (err instanceof CloudApiError && (err.statusCode === 401 || err.statusCode === 403)) {
        await callback?.({
          text: SESSION_REQUIRED_MESSAGE,
          actions: ["CLOUD_CREATE_API_KEY"],
        });
        return {
          success: false,
          text: "Eliza Cloud API keys require a signed-in session to create.",
          userFacingText: SESSION_REQUIRED_MESSAGE,
          data: { reason: "session_required" },
        };
      }
      logger.warn(
        `[CLOUD_CREATE_API_KEY] Failed to create key: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["CLOUD_CREATE_API_KEY"] });
      return {
        success: false,
        text: "Failed to create Eliza Cloud API key.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: 'create a cloud api key called "ci-deploys"' } },
      {
        name: "{{agent}}",
        content: {
          text: 'Created Eliza Cloud API key "ci-deploys". Copy it now — this is the only time the full key is shown.',
          actions: ["CLOUD_CREATE_API_KEY"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "make me a new eliza cloud api key" } },
      {
        name: "{{agent}}",
        content: {
          text: "Eliza Cloud only allows API keys to be created from a signed-in session — open the Cloud app or the console to create one.",
          actions: ["CLOUD_CREATE_API_KEY"],
        },
      },
    ],
  ],
};

export default createCloudApiKeyAction;
