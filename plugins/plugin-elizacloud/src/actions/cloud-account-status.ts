/**
 * CLOUD_ACCOUNT_STATUS — answer "how many credits do I have?" / "what's my
 * cloud account status?" with a fresh (uncached) balance read plus the
 * low/critical top-up nudge.
 *
 * Read-only: hits `GET /credits/balance` through the typed SDK with the
 * runtime's `ELIZAOS_CLOUD_API_KEY` (never the steward token — that credential
 * belongs to the browser). `validate` gates on the CLOUD_AUTH service being
 * authenticated so the action vanishes from the planner tool list when the
 * agent is signed out; the handler re-guards because validate is advisory and
 * a native tool call can bypass it.
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
import { isCloudAuthApiKeyService } from "../cloud/auth-service-types";
import { createElizaCloudClient } from "../utils/sdk-client";

const TOP_UP_URL = "https://www.elizacloud.ai/dashboard/settings?tab=billing";

export const NO_CLOUD_MESSAGE =
  "I'm not connected to Eliza Cloud right now — connect your account in Settings (or set ELIZAOS_CLOUD_API_KEY) and I can check your credits.";
const ERROR_MESSAGE =
  "I couldn't reach Eliza Cloud to check your account just now. Try again in a moment.";

/** Signed-in gate shared by the cloud account actions. */
export function cloudAccountAuthenticated(runtime: IAgentRuntime): boolean {
  const auth = runtime.getService("CLOUD_AUTH");
  return isCloudAuthApiKeyService(auth) && auth.isAuthenticated();
}

export const cloudAccountStatusAction: Action = {
  name: "CLOUD_ACCOUNT_STATUS",
  similes: ["CHECK_CLOUD_CREDITS", "CLOUD_CREDITS", "CLOUD_BALANCE"],
  description:
    "Check the user's Eliza Cloud account: current credit balance with a low-balance warning and top-up link. Use when the user asks about their cloud credits, balance, or account status.",
  descriptionCompressed: "Check Eliza Cloud credit balance / account status.",
  contexts: ["cloud", "finance", "settings"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    cloudAccountAuthenticated(runtime),

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!cloudAccountAuthenticated(runtime)) {
      await callback?.({ text: NO_CLOUD_MESSAGE, actions: ["CLOUD_ACCOUNT_STATUS"] });
      return {
        success: false,
        text: "Not connected to Eliza Cloud.",
        userFacingText: NO_CLOUD_MESSAGE,
        data: { reason: "not_connected" },
      };
    }

    try {
      const { balance } = await createElizaCloudClient(runtime).getCreditsBalance({
        fresh: true,
      });
      const low = balance < 2.0;
      const critical = balance < 0.5;

      let reply = `Your Eliza Cloud balance is $${balance.toFixed(2)}.`;
      if (critical) {
        reply += ` That's critically low — top up at ${TOP_UP_URL} to keep your agents running.`;
      } else if (low) {
        reply += ` That's running low — you can top up at ${TOP_UP_URL}.`;
      }

      await callback?.({ text: reply, actions: ["CLOUD_ACCOUNT_STATUS"] });
      return {
        success: true,
        text: `Eliza Cloud balance: $${balance.toFixed(2)}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { balance, low, critical, topUpUrl: TOP_UP_URL },
      };
    } catch (err) {
      logger.warn(
        `[CLOUD_ACCOUNT_STATUS] Failed to fetch balance: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["CLOUD_ACCOUNT_STATUS"] });
      return {
        success: false,
        text: "Failed to fetch Eliza Cloud balance.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "how many cloud credits do I have?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Your Eliza Cloud balance is $12.40.",
          actions: ["CLOUD_ACCOUNT_STATUS"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "what's my eliza cloud account looking like" } },
      {
        name: "{{agent}}",
        content: {
          text: "Your Eliza Cloud balance is $0.32. That's critically low — top up to keep your agents running.",
          actions: ["CLOUD_ACCOUNT_STATUS"],
        },
      },
    ],
  ],
};

export default cloudAccountStatusAction;
