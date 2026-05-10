// TikTok Marketing API integration - https://business-api.tiktok.com/marketing_api/docs

import { logger } from "@/lib/utils/logger";
import type {
  AdAccountCredentials,
  AdProvider,
  AdProviderCampaignResult,
  AdProviderCreativeResult,
  AdProviderMetricsResult,
  AdProviderValidationResult,
  CampaignMetrics,
  CreateCampaignInput,
  CreateCreativeInput,
  UpdateCampaignInput,
} from "../types";

const TIKTOK_ADS_API_VERSION = "v1.3";
const TIKTOK_ADS_BASE_URL = `https://business-api.tiktok.com/open_api/${TIKTOK_ADS_API_VERSION}`;

interface TikTokAdsResponse<T> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

interface TikTokAdvertiser {
  advertiser_id: string;
  advertiser_name: string;
  status: string;
}

async function tiktokAdsRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit & { params?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${TIKTOK_ADS_BASE_URL}${endpoint}`);

  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      "Access-Token": accessToken,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const json = (await response.json()) as TikTokAdsResponse<T>;

  if (json.code !== 0) {
    throw new Error(json.message || `TikTok Ads API error: ${json.code}`);
  }

  return json.data;
}

function mapObjectiveToTikTok(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "REACH",
    traffic: "TRAFFIC",
    engagement: "VIDEO_VIEWS",
    leads: "LEAD_GENERATION",
    app_promotion: "APP_PROMOTION",
    sales: "CONVERSIONS",
    conversions: "CONVERSIONS",
  };

  return mapping[objective] || "TRAFFIC";
}

function mapCtaToTikTok(cta?: string): string {
  const mapping: Record<string, string> = {
    learn_more: "LEARN_MORE",
    shop_now: "SHOP_NOW",
    sign_up: "SIGN_UP",
    subscribe: "SUBSCRIBE",
    contact_us: "CONTACT_US",
    get_offer: "GET_QUOTE",
    book_now: "BOOK_NOW",
    download: "DOWNLOAD",
    watch_more: "WATCH_MORE",
    apply_now: "APPLY_NOW",
    LEARN_MORE: "LEARN_MORE",
    SHOP_NOW: "SHOP_NOW",
    SIGN_UP: "SIGN_UP",
    SUBSCRIBE: "SUBSCRIBE",
    CONTACT_US: "CONTACT_US",
    GET_OFFER: "GET_QUOTE",
    BOOK_NOW: "BOOK_NOW",
    DOWNLOAD: "DOWNLOAD",
    INSTALL: "INSTALL_NOW",
  };

  return mapping[cta || "LEARN_MORE"] || "LEARN_MORE";
}

function splitTikTokCampaignId(
  accountId: string,
  externalCampaignId: string,
): { advertiserId: string; campaignId: string } {
  const parts = externalCampaignId.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { advertiserId: parts[0], campaignId: parts[1] };
  }
  return { advertiserId: accountId, campaignId: externalCampaignId };
}

function tiktokScheduleTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export const tiktokAdsProvider: AdProvider = {
  platform: "tiktok",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    const data = await tiktokAdsRequest<{ list: TikTokAdvertiser[] }>(
      "/advertiser/info/",
      credentials.accessToken,
      {
        method: "GET",
        params: { advertiser_ids: "[]" },
      },
    ).catch((err) => {
      logger.error("[TikTokAds] Validation failed", { error: err.message });
      return null;
    });

    if (!data?.list?.length) {
      return {
        valid: false,
        error: "No TikTok Ads accounts found or invalid credentials",
      };
    }

    const account = data.list[0];
    return {
      valid: true,
      accountId: account.advertiser_id,
      accountName: account.advertiser_name,
    };
  },

  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }> {
    const response = await fetch(`${TIKTOK_ADS_BASE_URL}/oauth2/refresh_token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: process.env.TIKTOK_ADS_APP_ID,
        secret: process.env.TIKTOK_ADS_APP_SECRET,
        refresh_token: refreshToken,
      }),
    });

    const json = (await response.json()) as TikTokAdsResponse<{
      access_token: string;
      refresh_token: string;
      refresh_token_expires_in: number;
    }>;

    if (json.code !== 0) {
      throw new Error("Failed to refresh TikTok token");
    }

    return {
      accessToken: json.data.access_token,
      refreshToken: json.data.refresh_token,
      expiresAt: new Date(Date.now() + json.data.refresh_token_expires_in * 1000),
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const data = await tiktokAdsRequest<{ list: TikTokAdvertiser[] }>(
      "/advertiser/info/",
      credentials.accessToken,
      { method: "GET" },
    );

    return (data.list || []).map((account) => ({
      id: account.advertiser_id,
      name: account.advertiser_name,
    }));
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    logger.info("[TikTokAds] Creating campaign", {
      accountId,
      name: input.name,
      objective: input.objective,
    });

    const objective = mapObjectiveToTikTok(input.objective);

    // Convert budget to cents (TikTok uses smallest currency unit)
    const budgetCents = Math.round(input.budgetAmount * 100);

    const data = await tiktokAdsRequest<{ campaign_id: string }>(
      "/campaign/create/",
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          advertiser_id: accountId,
          campaign_name: input.name,
          objective_type: objective,
          budget_mode: input.budgetType === "daily" ? "BUDGET_MODE_DAY" : "BUDGET_MODE_TOTAL",
          budget: budgetCents,
          operation_status: "DISABLE", // Start paused
        }),
      },
    );

    logger.info("[TikTokAds] Campaign created", {
      campaignId: data.campaign_id,
    });

    return {
      success: true,
      externalCampaignId: `${accountId}/${data.campaign_id}`,
    };
  },

  async updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    const parts = externalCampaignId.split("/");
    if (parts.length !== 2) {
      return {
        success: false,
        error: "Invalid campaign ID format (expected advertiserId/campaignId)",
      };
    }
    const [advertiserId, campaignId] = parts;

    const updatePayload: Record<string, unknown> = {
      advertiser_id: advertiserId,
      campaign_id: campaignId,
    };

    if (input.name) {
      updatePayload.campaign_name = input.name;
    }

    if (input.budgetAmount) {
      updatePayload.budget = Math.round(input.budgetAmount * 100);
    }

    await tiktokAdsRequest("/campaign/update/", credentials.accessToken, {
      method: "POST",
      body: JSON.stringify(updatePayload),
    });

    return { success: true, externalCampaignId };
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const parts = externalCampaignId.split("/");
    if (parts.length !== 2) {
      return { success: false, error: "Invalid campaign ID format" };
    }
    const [advertiserId, campaignId] = parts;

    await tiktokAdsRequest("/campaign/update/status/", credentials.accessToken, {
      method: "POST",
      body: JSON.stringify({
        advertiser_id: advertiserId,
        campaign_ids: [campaignId],
        operation_status: "DISABLE",
      }),
    });

    return { success: true, externalCampaignId };
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const parts = externalCampaignId.split("/");
    if (parts.length !== 2) {
      return { success: false, error: "Invalid campaign ID format" };
    }
    const [advertiserId, campaignId] = parts;

    await tiktokAdsRequest("/campaign/update/status/", credentials.accessToken, {
      method: "POST",
      body: JSON.stringify({
        advertiser_id: advertiserId,
        campaign_ids: [campaignId],
        operation_status: "ENABLE",
      }),
    });

    return { success: true, externalCampaignId };
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const parts = externalCampaignId.split("/");
    if (parts.length !== 2) {
      return { success: false, error: "Invalid campaign ID format" };
    }
    const [advertiserId, campaignId] = parts;

    await tiktokAdsRequest("/campaign/update/status/", credentials.accessToken, {
      method: "POST",
      body: JSON.stringify({
        advertiser_id: advertiserId,
        campaign_ids: [campaignId],
        operation_status: "DELETE",
      }),
    });

    return { success: true };
  },

  async createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult> {
    logger.info("[TikTokAds] Creating creative", {
      accountId,
      campaignId: externalCampaignId,
      name: input.name,
    });
    const { advertiserId, campaignId } = splitTikTokCampaignId(accountId, externalCampaignId);
    const primaryMedia = input.media[0];
    if (primaryMedia && !primaryMedia.providerAssetId) {
      return {
        success: false,
        error:
          "TikTok creatives require media.providerAssetId from a prior TikTok asset upload/search",
      };
    }

    // First, create an ad group
    const adGroupData = await tiktokAdsRequest<{ adgroup_id: string }>(
      "/adgroup/create/",
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          advertiser_id: advertiserId,
          campaign_id: campaignId,
          adgroup_name: `${input.name} - Ad Group`,
          promotion_type: "WEBSITE",
          placement_type: "PLACEMENT_TYPE_AUTOMATIC",
          budget_mode: "BUDGET_MODE_INFINITE",
          schedule_type: "SCHEDULE_START_END",
          schedule_start_time: tiktokScheduleTime(new Date()),
          billing_event: "CPC",
          bid_type: "BID_TYPE_NO_BID",
          operation_status: "DISABLE",
        }),
      },
    );

    // Create the ad
    const adData = await tiktokAdsRequest<{ ad_id: string }>(
      "/ad/create/",
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          advertiser_id: advertiserId,
          adgroup_id: adGroupData.adgroup_id,
          creatives: [
            {
              ad_name: input.name,
              ad_text: input.primaryText || input.description || "",
              call_to_action: mapCtaToTikTok(input.callToAction),
              landing_page_url: input.destinationUrl,
              display_name: input.headline || input.name,
              ...(input.tiktokIdentityId && { identity_id: input.tiktokIdentityId }),
              ...(input.tiktokIdentityType && { identity_type: input.tiktokIdentityType }),
              ...(primaryMedia?.type === "image"
                ? { image_ids: [primaryMedia.providerAssetId] }
                : {}),
              ...(primaryMedia?.type === "video" ? { video_id: primaryMedia.providerAssetId } : {}),
            },
          ],
        }),
      },
    );

    return {
      success: true,
      externalCreativeId: adData.ad_id,
    };
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const parts = externalCampaignId.split("/");
    if (parts.length !== 2) {
      return { success: false, error: "Invalid campaign ID format" };
    }
    const [advertiserId, campaignId] = parts;

    const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.end || new Date();

    const data = await tiktokAdsRequest<{
      list: Array<{
        metrics: {
          spend: string;
          impressions: string;
          clicks: string;
          conversion: string;
        };
      }>;
    }>("/report/integrated/get/", credentials.accessToken, {
      method: "GET",
      params: {
        advertiser_id: advertiserId,
        campaign_ids: JSON.stringify([campaignId]),
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id"]),
        metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion"]),
        start_date: startDate.toISOString().split("T")[0],
        end_date: endDate.toISOString().split("T")[0],
        report_type: "BASIC",
      },
    });

    const result = data.list?.[0];
    if (!result) {
      return {
        success: true,
        metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
      };
    }

    const metrics: CampaignMetrics = {
      spend: parseFloat(result.metrics.spend || "0"),
      impressions: parseInt(result.metrics.impressions || "0"),
      clicks: parseInt(result.metrics.clicks || "0"),
      conversions: parseInt(result.metrics.conversion || "0"),
    };

    return { success: true, metrics };
  },
};
