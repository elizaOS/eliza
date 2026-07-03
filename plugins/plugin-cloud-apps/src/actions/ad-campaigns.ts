/**
 * Advertising campaign actions (#11599).
 *
 * SET_AD_CAMPAIGN_DAYPARTING updates delivery windows through the Cloud API.
 * DUPLICATE_AD_CAMPAIGN copies a campaign config without spend/provider state.
 */

import type {
  CampaignDaypartingSchedule,
  CampaignPerformanceReportResponse,
  CreateCampaignReportShareResponse,
  DuplicateAdCampaignInput,
} from "@elizaos/cloud-sdk";
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
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can manage ad campaigns.";

function readOpt(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return record.parameters && typeof record.parameters === "object"
    ? (record.parameters as Record<string, unknown>)
    : record;
}

function readCampaignId(options: Record<string, unknown>): string | null {
  const value = options.campaignId ?? options.id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDayparting(
  options: Record<string, unknown>,
): CampaignDaypartingSchedule | null {
  const value = options.dayparting ?? options.schedule;
  if (!value || typeof value !== "object") return null;
  return value as CampaignDaypartingSchedule;
}

function readBoolean(options: Record<string, unknown>, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

function formatReportSummary(
  report: CampaignPerformanceReportResponse["report"],
): string {
  const s = report.summary;
  return [
    `Campaign "${report.campaign.name}" (${report.campaign.status})`,
    `Spend: ${report.campaign.budgetCurrency} ${s.spend.toFixed(2)} of ${report.campaign.budgetAmount.toFixed(2)}`,
    `Impressions: ${s.impressions}`,
    `Clicks: ${s.clicks}`,
    `Conversions: ${s.conversions}`,
    `CTR: ${s.ctr.toFixed(2)}%`,
    `CPC: ${report.campaign.budgetCurrency} ${s.cpc.toFixed(2)}`,
    `CPM: ${report.campaign.budgetCurrency} ${s.cpm.toFixed(2)}`,
  ].join("\n");
}

export const setAdCampaignDaypartingAction: Action = {
  name: "SET_AD_CAMPAIGN_DAYPARTING",
  similes: [
    "SCHEDULE_AD_CAMPAIGN",
    "SET_AD_DELIVERY_WINDOWS",
    "UPDATE_AD_DAYPARTING",
  ],
  description:
    "Set a Cloud advertising campaign's dayparting delivery schedule. Requires structured campaignId and dayparting { timezone, windows } parameters.",
  descriptionCompressed: "Set dayparting delivery windows for an ad campaign.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["SET_AD_CAMPAIGN_DAYPARTING"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const rec = readOpt(options);
    const campaignId = readCampaignId(rec);
    const dayparting = readDayparting(rec);
    if (!campaignId || !dayparting) {
      const msg =
        "I need a campaign id and a dayparting schedule with timezone and windows before I can update delivery.";
      await callback?.({ text: msg, actions: ["SET_AD_CAMPAIGN_DAYPARTING"] });
      return {
        success: false,
        text: "Missing campaign id or dayparting schedule.",
        userFacingText: msg,
        data: { reason: "missing_input" },
      };
    }

    try {
      const result = await client.updateAdCampaignDayparting(campaignId, {
        dayparting,
      });
      const windowCount = result.dayparting?.windows.length ?? 0;
      const reply = `Updated campaign ${campaignId} to use ${windowCount} dayparting window(s) in ${result.dayparting?.timezone}.`;
      await callback?.({
        text: reply,
        actions: ["SET_AD_CAMPAIGN_DAYPARTING"],
      });
      return {
        success: true,
        text: `Updated dayparting for campaign ${campaignId}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { result },
      };
    } catch (err) {
      logger.warn(
        `[SET_AD_CAMPAIGN_DAYPARTING] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't update that campaign schedule right now.";
      await callback?.({ text: msg, actions: ["SET_AD_CAMPAIGN_DAYPARTING"] });
      return {
        success: false,
        text: "Failed to update campaign dayparting.",
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
          text: "run campaign 11111111-1111-4111-8111-111111111111 weekdays 9 to 5 Pacific",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Updated campaign 11111111-1111-4111-8111-111111111111 to use 1 dayparting window(s) in America/Los_Angeles.",
          actions: ["SET_AD_CAMPAIGN_DAYPARTING"],
        },
      },
    ],
  ],
};

export const duplicateAdCampaignAction: Action = {
  name: "DUPLICATE_AD_CAMPAIGN",
  similes: ["COPY_AD_CAMPAIGN", "CLONE_AD_CAMPAIGN"],
  description:
    "Duplicate a Cloud advertising campaign config and creatives into a new draft. Requires structured campaignId; optional name sets the copy name.",
  descriptionCompressed: "Duplicate an ad campaign into a draft copy.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["DUPLICATE_AD_CAMPAIGN"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const rec = readOpt(options);
    const campaignId = readCampaignId(rec);
    if (!campaignId) {
      const msg = "I need the campaign id before I can duplicate it.";
      await callback?.({ text: msg, actions: ["DUPLICATE_AD_CAMPAIGN"] });
      return {
        success: false,
        text: "Missing campaign id.",
        userFacingText: msg,
        data: { reason: "missing_campaign_id" },
      };
    }

    const input: DuplicateAdCampaignInput = {};
    if (typeof rec.name === "string" && rec.name.trim()) {
      input.name = rec.name.trim();
    }

    try {
      const result = await client.duplicateAdCampaign(campaignId, input);
      const reply = `Created draft campaign "${result.campaign.name}" from ${campaignId} with ${result.creativesCopied} creative(s) copied.`;
      await callback?.({ text: reply, actions: ["DUPLICATE_AD_CAMPAIGN"] });
      return {
        success: true,
        text: `Duplicated campaign ${campaignId}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { result },
      };
    } catch (err) {
      logger.warn(
        `[DUPLICATE_AD_CAMPAIGN] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't duplicate that campaign right now.";
      await callback?.({ text: msg, actions: ["DUPLICATE_AD_CAMPAIGN"] });
      return {
        success: false,
        text: "Failed to duplicate campaign.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};

export const exportAdCampaignReportAction: Action = {
  name: "EXPORT_AD_CAMPAIGN_REPORT",
  similes: ["GET_AD_CAMPAIGN_REPORT", "SHARE_AD_CAMPAIGN_REPORT"],
  description:
    "Export a Cloud advertising campaign performance report. Requires structured campaignId; optional share=true creates a public expiring report link.",
  descriptionCompressed: "Export or share an ad campaign performance report.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["EXPORT_AD_CAMPAIGN_REPORT"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const rec = readOpt(options);
    const campaignId = readCampaignId(rec);
    if (!campaignId) {
      const msg = "I need the campaign id before I can export its report.";
      await callback?.({ text: msg, actions: ["EXPORT_AD_CAMPAIGN_REPORT"] });
      return {
        success: false,
        text: "Missing campaign id.",
        userFacingText: msg,
        data: { reason: "missing_campaign_id" },
      };
    }

    try {
      const report = await client.getAdCampaignPerformanceReport(campaignId);
      let share: CreateCampaignReportShareResponse["share"] | null = null;
      if (readBoolean(rec, "share")) {
        share = (
          await client.createAdCampaignReportShare(campaignId, {
            expiresInHours:
              typeof rec.expiresInHours === "number" ? rec.expiresInHours : 168,
          })
        ).share;
      }
      const reply = share
        ? `${formatReportSummary(report.report)}\nShare link: ${share.publicUrl}\nExpires: ${share.expiresAt}`
        : formatReportSummary(report.report);
      await callback?.({ text: reply, actions: ["EXPORT_AD_CAMPAIGN_REPORT"] });
      return {
        success: true,
        text: `Exported report for campaign ${campaignId}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { report: report.report, share },
      };
    } catch (err) {
      logger.warn(
        `[EXPORT_AD_CAMPAIGN_REPORT] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't export that campaign report right now.";
      await callback?.({ text: msg, actions: ["EXPORT_AD_CAMPAIGN_REPORT"] });
      return {
        success: false,
        text: "Failed to export campaign report.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};
