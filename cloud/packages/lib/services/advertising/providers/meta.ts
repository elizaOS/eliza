import { extractErrorMessage } from "@/lib/utils/error-handling";
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

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v24.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

const RATE_LIMIT = {
  requestsPerMinute: 200,
  requestTimestamps: [] as number[],
};

interface GraphApiError {
  error?: {
    message: string;
    code: number;
    type: string;
    error_subcode?: number;
  };
}

interface AdAccountResponse {
  id: string;
  name: string;
  account_status: number;
  currency: string;
  timezone_name: string;
}

interface CampaignResponse {
  id: string;
  name: string;
  status: string;
  objective: string;
}

function isRetryableError(code: number): boolean {
  // Rate limit errors (code 4, 17, 32, 613) and temporary errors (code 1, 2)
  return [1, 2, 4, 17, 32, 613].includes(code);
}

async function checkRateLimit(): Promise<void> {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Clean old timestamps
  RATE_LIMIT.requestTimestamps = RATE_LIMIT.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

  if (RATE_LIMIT.requestTimestamps.length >= RATE_LIMIT.requestsPerMinute) {
    const waitTime = RATE_LIMIT.requestTimestamps[0] - oneMinuteAgo + 100;
    logger.info("[MetaAds] Rate limit approaching, waiting", { waitTime });
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  RATE_LIMIT.requestTimestamps.push(now);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  await checkRateLimit();

  const url = new URL(endpoint.startsWith("http") ? endpoint : `${GRAPH_API_BASE}${endpoint}`);

  if (options.method === "GET") {
    url.searchParams.set("access_token", accessToken);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const json = await response.json();

    if ((json as GraphApiError).error) {
      const error = (json as GraphApiError).error!;
      lastError = new Error(`Meta API Error: ${error.message} (code: ${error.code})`);

      if (isRetryableError(error.code) && attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * 2 ** (attempt - 1),
          RETRY_CONFIG.maxDelayMs,
        );
        logger.info("[MetaAds] Retrying after error", {
          code: error.code,
          attempt,
          delay,
        });
        await sleep(delay);
        continue;
      }

      throw lastError;
    }

    return json as T;
  }

  throw lastError ?? new Error("Max retries exceeded");
}

function mapObjectiveToMeta(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "OUTCOME_AWARENESS",
    traffic: "OUTCOME_TRAFFIC",
    engagement: "OUTCOME_ENGAGEMENT",
    leads: "OUTCOME_LEADS",
    app_promotion: "OUTCOME_APP_PROMOTION",
    sales: "OUTCOME_SALES",
    conversions: "OUTCOME_SALES",
  };
  return mapping[objective] || "OUTCOME_AWARENESS";
}

function mapCtaToMeta(cta?: string): string {
  const mapping: Record<string, string> = {
    learn_more: "LEARN_MORE",
    shop_now: "SHOP_NOW",
    sign_up: "SIGN_UP",
    download: "DOWNLOAD",
    contact_us: "CONTACT_US",
    get_offer: "GET_OFFER",
    book_now: "BOOK_TRAVEL",
    watch_more: "WATCH_MORE",
    apply_now: "APPLY_NOW",
    subscribe: "SUBSCRIBE",
  };
  return cta ? mapping[cta] || "LEARN_MORE" : "LEARN_MORE";
}

export const metaAdsProvider: AdProvider = {
  platform: "meta",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    try {
      const response = await graphApiRequest<{
        id: string;
        name: string;
      }>("/me?fields=id,name", credentials.accessToken);

      return {
        valid: true,
        accountId: response.id,
        accountName: response.name,
      };
    } catch (error) {
      logger.error("[MetaAds] Validation failed", { error });
      return {
        valid: false,
        error: extractErrorMessage(error) || "Validation failed",
      };
    }
  },

  async refreshToken(currentToken: string) {
    // Meta uses long-lived tokens (60 days). To "refresh", we exchange the current
    // long-lived token for a new one before it expires. This requires app credentials.
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error("META_APP_ID and META_APP_SECRET required for token refresh");
    }

    const response = await graphApiRequest<{
      access_token: string;
      token_type: string;
      expires_in?: number;
    }>(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`,
      currentToken,
    );

    const expiresAt = response.expires_in
      ? new Date(Date.now() + response.expires_in * 1000)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // Default 60 days

    logger.info("[MetaAds] Token refreshed", { expiresAt });

    return {
      accessToken: response.access_token,
      expiresAt,
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await graphApiRequest<{
      data: AdAccountResponse[];
    }>(
      "/me/adaccounts?fields=id,name,account_status,currency,timezone_name",
      credentials.accessToken,
    );

    return response.data
      .filter((acc) => acc.account_status === 1) // Active accounts only
      .map((acc) => ({
        id: acc.id.replace("act_", ""),
        name: acc.name,
      }));
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      logger.info("[MetaAds] Creating campaign", {
        accountId,
        name: input.name,
        objective: input.objective,
      });

      const actAccountId = accountId.startsWith("act_") ? accountId : `act_${accountId}`;

      // Create campaign
      const campaignParams = new URLSearchParams({
        access_token: credentials.accessToken,
        name: input.name,
        objective: mapObjectiveToMeta(input.objective),
        status: "PAUSED", // Start paused, activate explicitly
        special_ad_categories: "[]",
      });

      const campaign = await graphApiRequest<CampaignResponse>(
        `/${actAccountId}/campaigns?${campaignParams}`,
        credentials.accessToken,
        { method: "POST" },
      );

      // Create ad set with budget and targeting
      const adSetParams: Record<string, string> = {
        access_token: credentials.accessToken,
        name: `${input.name} - Ad Set`,
        campaign_id: campaign.id,
        status: "PAUSED",
        billing_event: "IMPRESSIONS",
        optimization_goal: "REACH",
      };

      if (input.budgetType === "daily") {
        adSetParams.daily_budget = String(Math.round(input.budgetAmount * 100));
      } else {
        adSetParams.lifetime_budget = String(Math.round(input.budgetAmount * 100));
      }

      if (input.startDate) {
        adSetParams.start_time = input.startDate.toISOString();
      }
      if (input.endDate) {
        adSetParams.end_time = input.endDate.toISOString();
      }

      // Build targeting
      const targeting: Record<string, unknown> = {};

      if (input.targeting?.locations?.length) {
        targeting.geo_locations = {
          countries: input.targeting.locations,
        };
      } else {
        // Default to US
        targeting.geo_locations = { countries: ["US"] };
      }

      if (input.targeting?.ageMin || input.targeting?.ageMax) {
        targeting.age_min = input.targeting.ageMin || 18;
        targeting.age_max = input.targeting.ageMax || 65;
      }

      if (input.targeting?.genders?.length) {
        const genderMap: Record<string, number> = {
          male: 1,
          female: 2,
        };
        targeting.genders = input.targeting.genders
          .filter((g) => g !== "all")
          .map((g) => genderMap[g]);
      }

      if (input.targeting?.interests?.length) {
        targeting.flexible_spec = [
          {
            interests: input.targeting.interests.map((i) => ({ name: i })),
          },
        ];
      }

      adSetParams.targeting = JSON.stringify(targeting);

      await graphApiRequest(
        `/${actAccountId}/adsets?${new URLSearchParams(adSetParams)}`,
        credentials.accessToken,
        { method: "POST" },
      );

      logger.info("[MetaAds] Campaign created", { campaignId: campaign.id });

      return {
        success: true,
        externalCampaignId: campaign.id,
      };
    } catch (error) {
      logger.error("[MetaAds] Create campaign failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to create campaign",
      };
    }
  },

  async updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      const params: Record<string, string> = {
        access_token: credentials.accessToken,
      };

      if (input.name) {
        params.name = input.name;
      }

      const updateParams = new URLSearchParams(params);

      await graphApiRequest(`/${externalCampaignId}?${updateParams}`, credentials.accessToken, {
        method: "POST",
      });

      logger.info("[MetaAds] Campaign updated", { externalCampaignId });

      return { success: true, externalCampaignId };
    } catch (error) {
      logger.error("[MetaAds] Update campaign failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to update campaign",
      };
    }
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    try {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
        status: "PAUSED",
      });

      await graphApiRequest(`/${externalCampaignId}?${params}`, credentials.accessToken, {
        method: "POST",
      });

      logger.info("[MetaAds] Campaign paused", { externalCampaignId });

      return { success: true, externalCampaignId };
    } catch (error) {
      logger.error("[MetaAds] Pause campaign failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to pause campaign",
      };
    }
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    try {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
        status: "ACTIVE",
      });

      await graphApiRequest(`/${externalCampaignId}?${params}`, credentials.accessToken, {
        method: "POST",
      });

      logger.info("[MetaAds] Campaign activated", { externalCampaignId });

      return { success: true, externalCampaignId };
    } catch (error) {
      logger.error("[MetaAds] Activate campaign failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to activate campaign",
      };
    }
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
      });

      await graphApiRequest(`/${externalCampaignId}?${params}`, credentials.accessToken, {
        method: "DELETE",
      });

      logger.info("[MetaAds] Campaign deleted", { externalCampaignId });

      return { success: true };
    } catch (error) {
      logger.error("[MetaAds] Delete campaign failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to delete campaign",
      };
    }
  },

  async createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult> {
    try {
      logger.info("[MetaAds] Creating creative", {
        accountId,
        campaignId: externalCampaignId,
        name: input.name,
      });

      const actAccountId = accountId.startsWith("act_") ? accountId : `act_${accountId}`;

      // Get the ad set for this campaign
      const adSets = await graphApiRequest<{
        data: Array<{ id: string; name: string }>;
      }>(
        `/${externalCampaignId}/adsets?fields=id,name&access_token=${credentials.accessToken}`,
        credentials.accessToken,
      );

      if (!adSets.data.length) {
        return { success: false, error: "No ad set found for campaign" };
      }

      const adSetId = adSets.data[0].id;

      if (!input.destinationUrl) {
        return {
          success: false,
          error: "Destination URL is required for creative",
        };
      }
      const pageId = input.pageId || process.env.META_DEFAULT_PAGE_ID;
      if (!pageId) {
        return {
          success: false,
          error: "pageId is required for Meta link ad creatives",
        };
      }
      const instagramActorId =
        input.instagramActorId || process.env.META_DEFAULT_INSTAGRAM_ACTOR_ID;

      // Create ad creative
      const linkData: Record<string, unknown> = {
        link: input.destinationUrl,
        message: input.primaryText ?? "",
        name: input.headline ?? "",
        description: input.description ?? "",
        call_to_action: {
          type: mapCtaToMeta(input.callToAction),
        },
      };
      const creativeData: Record<string, unknown> = {
        name: input.name,
        object_story_spec: {
          page_id: pageId,
          ...(instagramActorId && { instagram_actor_id: instagramActorId }),
          link_data: linkData,
        },
      };

      // Add image if provided
      if (input.media.length > 0 && input.media[0].type === "image") {
        linkData.picture = input.media[0].url;
      }

      const creativeParams = new URLSearchParams({
        access_token: credentials.accessToken,
        ...Object.fromEntries(
          Object.entries(creativeData).map(([k, v]) => [
            k,
            typeof v === "object" ? JSON.stringify(v) : String(v),
          ]),
        ),
      });

      const creative = await graphApiRequest<{ id: string }>(
        `/${actAccountId}/adcreatives?${creativeParams}`,
        credentials.accessToken,
        { method: "POST" },
      );

      // Create ad linking creative to ad set
      const adParams = new URLSearchParams({
        access_token: credentials.accessToken,
        name: input.name,
        adset_id: adSetId,
        creative: JSON.stringify({ creative_id: creative.id }),
        status: "PAUSED",
      });

      const ad = await graphApiRequest<{ id: string }>(
        `/${actAccountId}/ads?${adParams}`,
        credentials.accessToken,
        { method: "POST" },
      );

      logger.info("[MetaAds] Creative created", {
        creativeId: creative.id,
        adId: ad.id,
      });

      return {
        success: true,
        externalCreativeId: creative.id,
      };
    } catch (error) {
      logger.error("[MetaAds] Create creative failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create creative",
      };
    }
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    try {
      const fields = ["spend", "impressions", "clicks", "conversions", "ctr", "cpc", "cpm"].join(
        ",",
      );

      let url = `/${externalCampaignId}/insights?fields=${fields}&access_token=${credentials.accessToken}`;

      if (dateRange) {
        url += `&time_range=${JSON.stringify({
          since: dateRange.start.toISOString().split("T")[0],
          until: dateRange.end.toISOString().split("T")[0],
        })}`;
      }

      const response = await graphApiRequest<{
        data: Array<{
          spend: string;
          impressions: string;
          clicks: string;
          conversions?: string;
          ctr?: string;
          cpc?: string;
          cpm?: string;
        }>;
      }>(url, credentials.accessToken);

      if (!response.data.length) {
        return {
          success: true,
          metrics: {
            spend: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0,
          },
        };
      }

      const data = response.data[0];
      const metrics: CampaignMetrics = {
        spend: parseFloat(data.spend) || 0,
        impressions: parseInt(data.impressions) || 0,
        clicks: parseInt(data.clicks) || 0,
        conversions: parseInt(data.conversions || "0") || 0,
        ctr: parseFloat(data.ctr || "0") || undefined,
        cpc: parseFloat(data.cpc || "0") || undefined,
        cpm: parseFloat(data.cpm || "0") || undefined,
      };

      return { success: true, metrics };
    } catch (error) {
      logger.error("[MetaAds] Get metrics failed", { error });
      return {
        success: false,
        error: extractErrorMessage(error) || "Failed to get metrics",
      };
    }
  },
};
