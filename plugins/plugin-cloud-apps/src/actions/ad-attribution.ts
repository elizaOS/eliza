/**
 * GET_AD_CAMPAIGN_ATTRIBUTION — copy/install first-party conversion attribution.
 *
 * Returns the signed conversion pixel and webhook instructions for a campaign.
 * Read-only: the backend may lazily mint the campaign secret/token, but this
 * action never records a conversion or changes spend.
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

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can fetch campaign attribution install instructions.";
const NO_CAMPAIGN_MESSAGE =
  "Which campaign should I prepare attribution instructions for? Send the campaign id.";

function readOpt(options: unknown): Record<string, unknown> | null {
  if (!options || typeof options !== "object") return null;
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

function extractCampaignId(message: Memory, options: unknown): string | null {
  const rec = readOpt(options);
  const candidate =
    rec?.campaignId ??
    rec?.campaign_id ??
    rec?.id ??
    message.content?.campaignId;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

export const getAdCampaignAttributionAction: Action = {
  name: "GET_AD_CAMPAIGN_ATTRIBUTION",
  similes: [
    "GET_CONVERSION_PIXEL",
    "GET_ATTRIBUTION_PIXEL",
    "GET_CAMPAIGN_WEBHOOK",
    "INSTALL_CONVERSION_TRACKING",
  ],
  description:
    "Fetch the signed conversion pixel and webhook install instructions for an Eliza Cloud advertising campaign by campaign id.",
  descriptionCompressed:
    "Fetch signed conversion pixel/webhook install instructions for a campaign.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

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
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["GET_AD_CAMPAIGN_ATTRIBUTION"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const campaignId = extractCampaignId(message, options);
    if (!campaignId) {
      await callback?.({
        text: NO_CAMPAIGN_MESSAGE,
        actions: ["GET_AD_CAMPAIGN_ATTRIBUTION"],
      });
      return {
        success: false,
        text: "No campaign id supplied.",
        userFacingText: NO_CAMPAIGN_MESSAGE,
        data: { reason: "no_campaign_id" },
      };
    }

    try {
      const attribution = await client.getAdCampaignAttribution(campaignId);
      const reply = [
        `Campaign ${attribution.campaignId} attribution is ready.`,
        `Pixel: ${attribution.install.pixelHtml}`,
        `Webhook: POST ${attribution.webhookEndpoint}`,
      ].join("\n");
      await callback?.({
        text: reply,
        actions: ["GET_AD_CAMPAIGN_ATTRIBUTION"],
      });
      return {
        success: true,
        text: `Fetched attribution instructions for campaign ${attribution.campaignId}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { attribution },
      };
    } catch (err) {
      logger.warn(
        `[GET_AD_CAMPAIGN_ATTRIBUTION] failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const msg =
        "I couldn't fetch campaign attribution instructions right now — the Cloud API returned an error.";
      await callback?.({
        text: msg,
        actions: ["GET_AD_CAMPAIGN_ATTRIBUTION"],
      });
      return {
        success: false,
        text: "Failed to fetch campaign attribution instructions.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "get conversion pixel for campaign camp_123",
          campaignId: "camp_123",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Campaign camp_123 attribution is ready.\nPixel: <img src="https://..." width="1" height="1" style="display:none" alt="" />\nWebhook: POST https://...',
          actions: ["GET_AD_CAMPAIGN_ATTRIBUTION"],
        },
      },
    ],
  ],
};
