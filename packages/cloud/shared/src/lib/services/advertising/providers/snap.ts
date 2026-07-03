// Snap Marketing API integration - https://developers.snap.com/marketing-api/Ads-API/introduction

import { logger } from "../../../utils/logger";
import { downloadAdMedia, mediaFileName } from "../media-utils";
import type {
  AdAccountCredentials,
  AdProvider,
  AdProviderCampaignResult,
  AdProviderCreativeResult,
  AdProviderMediaStatusResult,
  AdProviderMediaUploadResult,
  AdProviderMetricsResult,
  AdProviderValidationResult,
  CampaignMetrics,
  CreateCampaignInput,
  CreateCreativeInput,
  GetMediaStatusInput,
  UpdateCampaignInput,
  UploadMediaInput,
} from "../types";

const SNAP_ADS_BASE_URL = process.env.SNAP_ADS_BASE_URL || "https://adsapi.snapchat.com/v1";
const SNAP_DEFAULT_COUNTRY = "us";

interface SnapEnvelope {
  request_status?: string;
  request_id?: string;
  message?: string;
  debug_message?: string;
}

interface SnapOrganization {
  id: string;
  name?: string;
  ad_accounts?: SnapAdAccount[];
}

interface SnapAdAccount {
  id: string;
  name?: string;
  status?: string;
  roles?: string[];
  currency?: string;
  timezone?: string;
}

interface SnapMedia {
  id: string;
  ad_account_id?: string;
  name?: string;
  media_status?: string;
  download_link?: string;
  type?: string;
}

interface SnapCampaign {
  id: string;
}

interface SnapAdSquad {
  id: string;
}

interface SnapCreative {
  id: string;
}

interface SnapAd {
  id: string;
}

interface SnapStats {
  spend?: number;
  paid_impressions?: number;
  swipes?: number;
  swipe_ups?: number;
  conversion_purchases?: number;
  conversion_sign_ups?: number;
  conversion_page_views?: number;
}

type SnapEntityEnvelope<T> = {
  sub_request_status?: string;
  sub_request_error_reason?: string;
} & T;

async function snapRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit & { params?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(endpoint.startsWith("http") ? endpoint : `${SNAP_ADS_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & SnapEnvelope) : ({} as T & SnapEnvelope);

  if (!response.ok || isSnapFailure(data.request_status)) {
    throw new Error(
      data.message ||
        data.debug_message ||
        `Snap Marketing API error: ${response.status || data.request_status || "UNKNOWN"}`,
    );
  }

  return data as T;
}

function isSnapFailure(status?: string): boolean {
  return Boolean(status && !["success", "SUCCESS"].includes(status));
}

function firstSnapEntity<T extends Record<string, unknown>, K extends keyof T>(
  items: Array<SnapEntityEnvelope<T>> | undefined,
  key: K,
  message: string,
): NonNullable<T[K]> {
  const item = items?.[0];
  if (!item || isSnapFailure(item.sub_request_status)) {
    throw new Error(item?.sub_request_error_reason || message);
  }
  const entity = item[key];
  if (!entity) throw new Error(message);
  return entity;
}

function microCurrency(amount: number): number {
  return Math.round(amount * 1_000_000);
}

function mapObjectiveToSnap(objective: string): {
  objective: string;
  objectiveV2Type: string;
  optimizationGoal: string;
} {
  const mapping: Record<
    string,
    { objective: string; objectiveV2Type: string; optimizationGoal: string }
  > = {
    awareness: {
      objective: "BRAND_AWARENESS",
      objectiveV2Type: "AWARENESS_AND_ENGAGEMENT",
      optimizationGoal: "IMPRESSIONS",
    },
    traffic: {
      objective: "WEB_VIEW",
      objectiveV2Type: "TRAFFIC",
      optimizationGoal: "SWIPES",
    },
    engagement: {
      objective: "ENGAGEMENT",
      objectiveV2Type: "AWARENESS_AND_ENGAGEMENT",
      optimizationGoal: "SWIPES",
    },
    leads: {
      objective: "LEAD_GENERATION",
      objectiveV2Type: "LEADS",
      optimizationGoal: "LEAD_FORM_SUBMISSIONS",
    },
    app_promotion: {
      objective: "APP_INSTALL",
      objectiveV2Type: "APP_PROMOTION",
      optimizationGoal: "APP_INSTALLS",
    },
    sales: {
      objective: "WEB_CONVERSION",
      objectiveV2Type: "SALES",
      optimizationGoal: "PIXEL_PURCHASE",
    },
    conversions: {
      objective: "WEB_CONVERSION",
      objectiveV2Type: "SALES",
      optimizationGoal: "PIXEL_PURCHASE",
    },
  };
  return mapping[objective] ?? mapping.traffic;
}

function mapCtaToSnap(cta?: string): string {
  const mapping: Record<string, string> = {
    learn_more: "LEARN_MORE",
    shop_now: "SHOP_NOW",
    sign_up: "SIGN_UP",
    download: "DOWNLOAD",
    contact_us: "CONTACT_US",
    get_offer: "GET_OFFER",
    book_now: "BOOK_NOW",
    watch_more: "WATCH_MORE",
    apply_now: "APPLY_NOW",
    subscribe: "SUBSCRIBE",
  };
  return mapping[cta || "learn_more"] || "LEARN_MORE";
}

function splitSnapCampaignId(
  fallbackAccountId: string,
  externalCampaignId: string,
): { accountId: string; campaignId: string; adSquadId?: string } {
  const parts = externalCampaignId.split("/");
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { accountId: parts[0], campaignId: parts[1], adSquadId: parts[2] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { accountId: parts[0], campaignId: parts[1] };
  }
  return { accountId: fallbackAccountId, campaignId: externalCampaignId };
}

function snapPatch(
  path: string,
  value: unknown,
): Array<{ op: "replace"; path: string; value: unknown }> {
  return [{ op: "replace", path, value }];
}

function snapTargeting(input: CreateCampaignInput): Record<string, unknown> {
  const countries = input.targeting?.locations?.length
    ? input.targeting.locations
    : [SNAP_DEFAULT_COUNTRY];
  return {
    geos: countries.map((country) => ({ country_code: country.toLowerCase() })),
  };
}

export const snapAdsProvider: AdProvider = {
  platform: "snap",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    const accounts = await this.listAdAccounts(credentials).catch((error) => {
      logger.error("[SnapAds] Validation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });

    const account = accounts[0];
    if (!account) {
      return {
        valid: false,
        error: "No Snap ad accounts found or invalid credentials",
      };
    }

    return {
      valid: true,
      accountId: account.id,
      accountName: account.name,
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await snapRequest<{
      organizations?: Array<{ organization?: SnapOrganization }>;
    }>("/me/organizations", credentials.accessToken, {
      method: "GET",
      params: { with_ad_accounts: "true" },
    });

    return (response.organizations ?? []).flatMap((entry) =>
      (entry.organization?.ad_accounts ?? []).map((account) => ({
        id: account.id,
        name: account.name || `Snap Ad Account ${account.id}`,
      })),
    );
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      logger.info("[SnapAds] Creating campaign", {
        accountId,
        name: input.name,
        objective: input.objective,
      });

      const objective = mapObjectiveToSnap(input.objective);
      const startTime = (input.startDate ?? new Date()).toISOString();
      const endTime = input.endDate?.toISOString();
      const budgetMicro = microCurrency(input.budgetAmount);

      const campaignResponse = await snapRequest<{
        campaigns?: Array<SnapEntityEnvelope<{ campaign?: SnapCampaign }>>;
      }>(`/adaccounts/${accountId}/campaigns`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({
          campaigns: [
            {
              ad_account_id: accountId,
              name: input.name,
              status: "PAUSED",
              start_time: startTime,
              ...(endTime ? { end_time: endTime } : {}),
              buy_model: "AUCTION",
              creation_state: "PUBLISHED",
              objective: objective.objective,
              objective_v2_properties: {
                objective_v2_type: objective.objectiveV2Type,
              },
              ...(input.budgetType === "daily"
                ? { daily_budget_micro: budgetMicro }
                : { lifetime_spend_cap_micro: budgetMicro }),
            },
          ],
        }),
      });
      const campaign = firstSnapEntity(
        campaignResponse.campaigns,
        "campaign",
        "Snap campaign creation returned no campaign",
      );

      const adSquadResponse = await snapRequest<{
        adsquads?: Array<SnapEntityEnvelope<{ adsquad?: SnapAdSquad }>>;
      }>(`/campaigns/${campaign.id}/adsquads`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({
          adsquads: [
            {
              campaign_id: campaign.id,
              name: `${input.name} - Ad Squad`,
              type: "SNAP_ADS",
              placement_v2: { config: "AUTOMATIC" },
              optimization_goal: objective.optimizationGoal,
              billing_event: "IMPRESSION",
              bid_strategy: "AUTO_BID",
              ...(input.budgetType === "daily"
                ? { daily_budget_micro: budgetMicro }
                : { lifetime_budget_micro: budgetMicro }),
              targeting: snapTargeting(input),
              start_time: startTime,
              ...(endTime ? { end_time: endTime } : {}),
              status: "PAUSED",
            },
          ],
        }),
      });
      const adSquad = firstSnapEntity(
        adSquadResponse.adsquads,
        "adsquad",
        "Snap ad squad creation returned no ad squad",
      );

      logger.info("[SnapAds] Campaign created", {
        accountId,
        campaignId: campaign.id,
        adSquadId: adSquad.id,
      });

      return {
        success: true,
        externalCampaignId: `${accountId}/${campaign.id}/${adSquad.id}`,
      };
    } catch (error) {
      logger.error("[SnapAds] Campaign creation failed", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Snap campaign creation failed",
      };
    }
  },

  async updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId, adSquadId } = splitSnapCampaignId("", externalCampaignId);
    const campaignOps: Array<{ op: "replace"; path: string; value: unknown }> = [];
    if (input.name) campaignOps.push(...snapPatch("/name", input.name));
    if (input.startDate)
      campaignOps.push(...snapPatch("/start_time", input.startDate.toISOString()));
    if (input.endDate) campaignOps.push(...snapPatch("/end_time", input.endDate.toISOString()));

    if (campaignOps.length) {
      await snapRequest(
        `/adaccounts/${accountId}/campaigns/${campaignId}`,
        credentials.accessToken,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json-patch+json" },
          body: JSON.stringify(campaignOps),
        },
      );
    }

    if (input.budgetAmount && adSquadId) {
      await snapRequest(`/campaigns/${campaignId}/adsquads/${adSquadId}`, credentials.accessToken, {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(snapPatch("/daily_budget_micro", microCurrency(input.budgetAmount))),
      });
    }

    return { success: true, externalCampaignId };
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId, adSquadId } = splitSnapCampaignId("", externalCampaignId);
    await snapRequest(`/adaccounts/${accountId}/campaigns/${campaignId}`, credentials.accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(snapPatch("/status", "PAUSED")),
    });
    if (adSquadId) {
      await snapRequest(`/campaigns/${campaignId}/adsquads/${adSquadId}`, credentials.accessToken, {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(snapPatch("/status", "PAUSED")),
      });
    }
    return { success: true, externalCampaignId };
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId, adSquadId } = splitSnapCampaignId("", externalCampaignId);
    await snapRequest(`/adaccounts/${accountId}/campaigns/${campaignId}`, credentials.accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(snapPatch("/status", "ACTIVE")),
    });
    if (adSquadId) {
      await snapRequest(`/campaigns/${campaignId}/adsquads/${adSquadId}`, credentials.accessToken, {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(snapPatch("/status", "ACTIVE")),
      });
    }
    return { success: true, externalCampaignId };
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { campaignId } = splitSnapCampaignId("", externalCampaignId);
    await snapRequest(`/campaigns/${campaignId}`, credentials.accessToken, { method: "DELETE" });
    return { success: true };
  },

  async createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult> {
    try {
      const { adSquadId } = splitSnapCampaignId(accountId, externalCampaignId);
      if (!adSquadId) {
        return {
          success: false,
          error: "Snap creatives require an external campaign id with an ad squad id",
        };
      }

      const primaryMedia = input.media[0];
      if (!primaryMedia?.providerAssetId) {
        return {
          success: false,
          error: "Snap creatives require media.providerAssetId from a prior Snap media upload",
        };
      }

      const creativeResponse = await snapRequest<{
        creatives?: Array<SnapEntityEnvelope<{ creative?: SnapCreative }>>;
      }>(`/adaccounts/${accountId}/creatives`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({
          creatives: [
            {
              ad_account_id: accountId,
              top_snap_media_id: primaryMedia.providerAssetId,
              name: input.name,
              type: "WEB_VIEW",
              shareable: true,
              call_to_action: mapCtaToSnap(input.callToAction),
              headline: (input.headline || input.name).slice(0, 34),
              brand_name: (input.description || input.name).slice(0, 32),
              top_snap_crop_position: "OPTIMIZED",
              web_view_properties: {
                url: input.destinationUrl,
                block_preload: false,
              },
            },
          ],
        }),
      });
      const creative = firstSnapEntity(
        creativeResponse.creatives,
        "creative",
        "Snap creative creation returned no creative",
      );

      const adResponse = await snapRequest<{
        ads?: Array<SnapEntityEnvelope<{ ad?: SnapAd }>>;
      }>(`/adsquads/${adSquadId}/ads`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({
          ads: [
            {
              ad_squad_id: adSquadId,
              creative_id: creative.id,
              name: input.name,
              type: "REMOTE_WEBPAGE",
              status: "PAUSED",
            },
          ],
        }),
      });
      const ad = firstSnapEntity(adResponse.ads, "ad", "Snap ad creation returned no ad");

      return { success: true, externalCreativeId: `${creative.id}/${ad.id}` };
    } catch (error) {
      logger.error("[SnapAds] Creative creation failed", {
        accountId,
        externalCampaignId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Snap creative creation failed",
      };
    }
  },

  async uploadMedia(
    credentials: AdAccountCredentials,
    accountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    try {
      const fileName = mediaFileName({
        name: input.name,
        url: input.url,
        contentType: input.mimeType,
        fallbackExtension: input.type === "video" ? "mp4" : "png",
      });
      const media = await downloadAdMedia(input.url, {
        allowedContentTypes:
          input.type === "video" ? ["video/mp4", "video/quicktime"] : ["image/jpeg", "image/png"],
        fileName,
      });

      const createResponse = await snapRequest<{
        media?: Array<SnapEntityEnvelope<{ media?: SnapMedia }>>;
      }>(`/adaccounts/${accountId}/media`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({
          media: [
            {
              name: fileName,
              type: input.type === "video" ? "VIDEO" : "IMAGE",
              ad_account_id: accountId,
            },
          ],
        }),
      });
      const createdMedia = firstSnapEntity(
        createResponse.media,
        "media",
        "Snap media creation returned no media",
      );

      const uploadBody = new ArrayBuffer(media.bytes.byteLength);
      new Uint8Array(uploadBody).set(media.bytes);
      const form = new FormData();
      form.append(
        "file",
        new Blob([uploadBody], { type: media.contentType }),
        media.fileName || fileName,
      );

      const uploadResponse = await snapRequest<{ result?: SnapMedia }>(
        `/media/${createdMedia.id}/upload`,
        credentials.accessToken,
        {
          method: "POST",
          body: form,
        },
      );

      const uploadedMedia = uploadResponse.result ?? createdMedia;
      return {
        success: true,
        providerAssetId: uploadedMedia.id,
        providerAssetResourceName: uploadedMedia.id,
        providerAssetUrl: uploadedMedia.download_link ?? media.url,
        metadata: {
          fileName,
          mediaStatus: uploadedMedia.media_status,
          mediaType: uploadedMedia.type,
        },
      };
    } catch (error) {
      logger.error("[SnapAds] Media upload failed", {
        accountId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Snap media upload failed",
      };
    }
  },

  async getMediaStatus(
    credentials: AdAccountCredentials,
    _accountId: string,
    input: GetMediaStatusInput,
  ): Promise<AdProviderMediaStatusResult> {
    const response = await snapRequest<{
      media?: Array<SnapEntityEnvelope<{ media?: SnapMedia }>>;
    }>(`/media/${input.providerAssetResourceName}`, credentials.accessToken, { method: "GET" });
    const media = firstSnapEntity(response.media, "media", "Snap media status returned no media");
    return {
      success: true,
      providerAssetId: media.id,
      providerAssetResourceName: media.id,
      providerAssetUrl: media.download_link,
      status: media.media_status,
      ready: media.media_status === "READY",
    };
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const { campaignId } = splitSnapCampaignId("", externalCampaignId);
    const params: Record<string, string> = {
      granularity: dateRange ? "TOTAL" : "LIFETIME",
      fields: "paid_impressions,swipes,swipe_ups,spend,conversion_purchases,conversion_sign_ups",
    };
    if (dateRange) {
      params.start_time = dateRange.start.toISOString();
      params.end_time = dateRange.end.toISOString();
    }

    const response = await snapRequest<{
      lifetime_stats?: Array<SnapEntityEnvelope<{ lifetime_stat?: { stats?: SnapStats } }>>;
      total_stats?: Array<SnapEntityEnvelope<{ total_stat?: { stats?: SnapStats } }>>;
    }>(`/campaigns/${campaignId}/stats`, credentials.accessToken, {
      method: "GET",
      params,
    });

    const rows =
      response.lifetime_stats?.map((item) => item.lifetime_stat?.stats) ??
      response.total_stats?.map((item) => item.total_stat?.stats) ??
      [];
    const totals = rows.reduce<CampaignMetrics>(
      (acc, row) => ({
        spend: acc.spend + (row?.spend ?? 0) / 1_000_000,
        impressions: acc.impressions + (row?.paid_impressions ?? 0),
        clicks: acc.clicks + (row?.swipes ?? row?.swipe_ups ?? 0),
        conversions:
          acc.conversions +
          (row?.conversion_purchases ?? 0) +
          (row?.conversion_sign_ups ?? 0) +
          (row?.conversion_page_views ?? 0),
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    );

    return { success: true, metrics: totals };
  },
};
