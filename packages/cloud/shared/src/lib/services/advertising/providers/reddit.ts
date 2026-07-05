// Reddit Ads API v3 integration - https://ads-api.reddit.com/docs/v3/

import { logger } from "../../../utils/logger";
import { assertSafeAdMediaUrl, mediaFileName } from "../media-utils";
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
  CampaignTargeting,
  CreateCampaignInput,
  CreateCreativeInput,
  UpdateCampaignInput,
  UploadMediaInput,
} from "../types";

const REDDIT_ADS_BASE_URL = "https://ads-api.reddit.com/api/v3";

interface RedditResponse<T> {
  data?: T;
  pagination?: {
    next_token?: string | null;
  };
  error?: {
    message?: string;
    code?: string;
  };
  message?: string;
}

interface RedditBusiness {
  id: string;
  name?: string | null;
}

interface RedditAdAccount {
  id: string;
  name?: string | null;
  currency?: string | null;
  time_zone_id?: string | null;
}

interface RedditProfile {
  id: string;
  name?: string | null;
}

interface RedditEntity {
  id?: string;
}

interface RedditReportRow {
  SPEND?: number | string | null;
  IMPRESSIONS?: number | string | null;
  CLICKS?: number | string | null;
  CONVERSIONS?: number | string | null;
  CTR?: number | string | null;
  CPC?: number | string | null;
  CPM?: number | string | null;
}

async function redditRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit & { params?: Record<string, string | undefined> } = {},
): Promise<RedditResponse<T>> {
  const url = new URL(`${REDDIT_ADS_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = (await response.json().catch(() => ({}))) as RedditResponse<T>;
  if (!response.ok) {
    throw new Error(
      json.error?.message || json.message || `Reddit Ads API error: ${response.status}`,
    );
  }
  return json;
}

function micros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

function isoHour(date: Date): string {
  const rounded = new Date(date);
  rounded.setUTCMinutes(0, 0, 0);
  return rounded.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mapObjectiveToReddit(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "IMPRESSIONS",
    traffic: "CLICKS",
    engagement: "CLICKS",
    leads: "LEAD_GENERATION",
    app_promotion: "APP_INSTALLS",
    sales: "CONVERSIONS",
    conversions: "CONVERSIONS",
  };
  return mapping[objective] || "CLICKS";
}

function mapBidType(input: Pick<CreateCampaignInput, "bidStrategy" | "objective">): string {
  if (input.bidStrategy === "cpm" || input.objective === "awareness") return "CPM";
  if (input.objective === "engagement") return "CPV";
  return "CPC";
}

function mapBidStrategy(input: Pick<CreateCampaignInput, "bidStrategy">): string {
  if (input.bidStrategy === "cpa") return "TARGET_CPX";
  return "BIDLESS";
}

function mapOptimizationGoal(
  input: Pick<CreateCampaignInput, "optimizationGoal" | "objective">,
): string | null {
  if (input.optimizationGoal === "reach") return "REACH";
  if (input.optimizationGoal === "conversions") return "PURCHASE";
  if (input.objective === "leads") return "LEAD";
  if (input.objective === "app_promotion") return "APP_INSTALL";
  return "CLICKS";
}

function mapTargeting(targeting?: CampaignTargeting): Record<string, unknown> {
  if (!targeting) return {};
  const mapped: Record<string, unknown> = {};
  if (targeting.locations?.length) mapped.geolocations = targeting.locations;
  if (targeting.interests?.length) mapped.interests = targeting.interests;
  if (targeting.behaviors?.length) mapped.keywords = targeting.behaviors;
  if (targeting.customAudiences?.length) mapped.custom_audience_ids = targeting.customAudiences;
  if (targeting.excludedAudiences?.length) {
    mapped.excluded_custom_audience_ids = targeting.excludedAudiences;
  }
  if (targeting.placements?.length) mapped.locations = targeting.placements;
  const gender = targeting.genders?.find((value) => value !== "all");
  if (gender) mapped.gender = gender.toUpperCase();
  return mapped;
}

function splitRedditCampaignId(externalCampaignId: string): {
  accountId?: string;
  campaignId: string;
  adGroupId?: string;
} {
  const [accountId, campaignId, adGroupId] = externalCampaignId.split("/");
  if (accountId && campaignId && adGroupId) return { accountId, campaignId, adGroupId };
  if (accountId && campaignId) return { accountId, campaignId };
  return { campaignId: externalCampaignId };
}

function firstId(response: RedditResponse<RedditEntity | RedditEntity[]>): string | undefined {
  if (Array.isArray(response.data)) return response.data[0]?.id;
  return response.data?.id;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return 0;
}

function sumReportRows(rows: RedditReportRow[] = []): CampaignMetrics {
  const metrics = rows.reduce(
    (acc, row) => ({
      spend: acc.spend + firstNumber(row.SPEND),
      impressions: acc.impressions + firstNumber(row.IMPRESSIONS),
      clicks: acc.clicks + firstNumber(row.CLICKS),
      conversions: acc.conversions + firstNumber(row.CONVERSIONS),
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
  );
  return {
    ...metrics,
    ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0,
    cpc: metrics.clicks > 0 ? metrics.spend / metrics.clicks : 0,
    cpm: metrics.impressions > 0 ? (metrics.spend / metrics.impressions) * 1000 : 0,
  };
}

async function listBusinesses(credentials: AdAccountCredentials): Promise<RedditBusiness[]> {
  const response = await redditRequest<RedditBusiness[]>(
    "/me/businesses",
    credentials.accessToken,
    {
      method: "GET",
      params: { "page.size": "100" },
    },
  );
  return response.data ?? [];
}

async function firstProfileId(
  credentials: AdAccountCredentials,
  accountId: string,
): Promise<string> {
  const response = await redditRequest<RedditProfile[]>(
    `/ad_accounts/${encodeURIComponent(accountId)}/profiles`,
    credentials.accessToken,
    { method: "GET", params: { "page.size": "1" } },
  );
  const id = response.data?.[0]?.id;
  if (!id) throw new Error("No Reddit Ads profile found for ad account");
  return id;
}

async function firstAdGroupForCampaign(
  credentials: AdAccountCredentials,
  accountId: string,
  campaignId: string,
): Promise<string> {
  const response = await redditRequest<RedditEntity[]>(
    `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`,
    credentials.accessToken,
    { method: "GET", params: { campaign_id: campaignId, "page.size": "1" } },
  );
  const id = response.data?.[0]?.id;
  if (!id) throw new Error("No Reddit Ads ad group found for campaign");
  return id;
}

function mapCtaToReddit(cta?: string): string {
  const mapping: Record<string, string> = {
    learn_more: "Learn More",
    shop_now: "Shop Now",
    sign_up: "Sign Up",
    download: "Download",
    contact_us: "Contact Us",
    get_offer: "Get a Quote",
    book_now: "Book Now",
    watch_more: "Watch Now",
    apply_now: "Apply Now",
    subscribe: "Subscribe",
  };
  return mapping[cta ?? "learn_more"] || "Learn More";
}

export const redditAdsProvider: AdProvider = {
  platform: "reddit",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    let accounts: Array<{ id: string; name: string }>;
    try {
      accounts = await this.listAdAccounts(credentials);
    } catch (error) {
      // error-policy:J1 boundary — surface the account-discovery transport/auth failure
      // verbatim so a failed fetch stays distinct from a valid account with zero ad accounts.
      logger.error("[RedditAds] Validation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Reddit credential validation failed",
      };
    }
    if (accounts.length === 0) {
      return { valid: false, error: "No Reddit Ads accounts found or invalid credentials" };
    }
    return {
      valid: true,
      accountId: accounts[0].id,
      accountName: accounts[0].name,
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const businesses = await listBusinesses(credentials);
    const accounts = await Promise.all(
      businesses.map(async (business) => {
        const response = await redditRequest<RedditAdAccount[]>(
          `/businesses/${encodeURIComponent(business.id)}/ad_accounts`,
          credentials.accessToken,
          { method: "GET", params: { "page.size": "100" } },
        );
        return response.data ?? [];
      }),
    );
    return accounts.flat().map((account) => ({
      id: account.id,
      name: account.name || account.id,
    }));
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      const objective = mapObjectiveToReddit(input.objective);
      const goalType = input.budgetType === "lifetime" ? "LIFETIME_SPEND" : "DAILY_SPEND";
      const campaignResponse = await redditRequest<RedditEntity>(
        `/ad_accounts/${encodeURIComponent(accountId)}/campaigns`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              name: input.name,
              objective,
              configured_status: "PAUSED",
              is_campaign_budget_optimization: false,
              spend_cap: input.budgetType === "lifetime" ? micros(input.budgetAmount) : null,
              start_time: input.startDate?.toISOString() ?? new Date().toISOString(),
              end_time: input.endDate?.toISOString() ?? null,
            },
          }),
        },
      );
      const campaignId = firstId(campaignResponse);
      if (!campaignId) throw new Error("Reddit campaign create returned no id");

      const adGroupResponse = await redditRequest<RedditEntity>(
        `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              name: `${input.name} Ad Group`,
              campaign_id: campaignId,
              configured_status: "PAUSED",
              goal_type: goalType,
              goal_value: micros(input.budgetAmount),
              bid_type: mapBidType(input),
              bid_strategy: mapBidStrategy(input),
              optimization_goal: mapOptimizationGoal(input),
              start_time: input.startDate?.toISOString() ?? new Date().toISOString(),
              end_time: input.endDate?.toISOString() ?? null,
              targeting: mapTargeting(input.targeting),
            },
          }),
        },
      );
      const adGroupId = firstId(adGroupResponse);
      if (!adGroupId) throw new Error("Reddit ad group create returned no id");

      return { success: true, externalCampaignId: `${accountId}/${campaignId}/${adGroupId}` };
    } catch (error) {
      logger.error("[RedditAds] Campaign creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      const { campaignId, adGroupId } = splitRedditCampaignId(externalCampaignId);
      const campaignPatch: Record<string, unknown> = {};
      if (input.name) campaignPatch.name = input.name;
      if (input.startDate) campaignPatch.start_time = input.startDate.toISOString();
      if (input.endDate !== undefined)
        campaignPatch.end_time = input.endDate?.toISOString() ?? null;
      if (input.budgetAmount !== undefined) campaignPatch.spend_cap = micros(input.budgetAmount);
      if (Object.keys(campaignPatch).length > 0) {
        await redditRequest(
          `/campaigns/${encodeURIComponent(campaignId)}`,
          credentials.accessToken,
          {
            method: "PATCH",
            body: JSON.stringify({ data: campaignPatch }),
          },
        );
      }
      if (adGroupId && input.budgetAmount !== undefined) {
        await redditRequest(
          `/ad_groups/${encodeURIComponent(adGroupId)}`,
          credentials.accessToken,
          {
            method: "PATCH",
            body: JSON.stringify({ data: { goal_value: micros(input.budgetAmount) } }),
          },
        );
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { campaignId, adGroupId } = splitRedditCampaignId(externalCampaignId);
    try {
      await redditRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ data: { configured_status: "PAUSED" } }),
      });
      if (adGroupId) {
        await redditRequest(
          `/ad_groups/${encodeURIComponent(adGroupId)}`,
          credentials.accessToken,
          {
            method: "PATCH",
            body: JSON.stringify({ data: { configured_status: "PAUSED" } }),
          },
        );
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { campaignId, adGroupId } = splitRedditCampaignId(externalCampaignId);
    try {
      await redditRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ data: { configured_status: "ACTIVE" } }),
      });
      if (adGroupId) {
        await redditRequest(
          `/ad_groups/${encodeURIComponent(adGroupId)}`,
          credentials.accessToken,
          {
            method: "PATCH",
            body: JSON.stringify({ data: { configured_status: "ACTIVE" } }),
          },
        );
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { campaignId, adGroupId } = splitRedditCampaignId(externalCampaignId);
    try {
      if (adGroupId) {
        await redditRequest(
          `/ad_groups/${encodeURIComponent(adGroupId)}`,
          credentials.accessToken,
          {
            method: "PATCH",
            body: JSON.stringify({ data: { configured_status: "ARCHIVED" } }),
          },
        );
      }
      await redditRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ data: { configured_status: "ARCHIVED" } }),
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult> {
    try {
      const { campaignId, adGroupId: compositeAdGroupId } =
        splitRedditCampaignId(externalCampaignId);
      const adGroupId =
        compositeAdGroupId ?? (await firstAdGroupForCampaign(credentials, accountId, campaignId));
      const profileId = input.pageId ?? (await firstProfileId(credentials, accountId));
      const orderedMedia = [...input.media].sort((a, b) => a.order - b.order);
      const primaryMedia = orderedMedia[0];
      const type =
        input.type === "video" ? "VIDEO" : input.type === "carousel" ? "CAROUSEL" : "IMAGE";
      const postResponse = await redditRequest<RedditEntity>(
        `/profiles/${encodeURIComponent(profileId)}/posts`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              type,
              headline: input.headline ?? input.name,
              body: input.primaryText ?? input.description ?? "",
              allow_comments: true,
              thumbnail_url: primaryMedia?.thumbnailUrl ?? null,
              content: orderedMedia.map((media) => ({
                media_url: media.url,
                destination_url: input.destinationUrl ?? null,
                call_to_action: mapCtaToReddit(input.callToAction),
              })),
            },
          }),
        },
      );
      const postId = firstId(postResponse);
      if (!postId) throw new Error("Reddit post create returned no id");
      const adResponse = await redditRequest<RedditEntity>(
        `/ad_accounts/${encodeURIComponent(accountId)}/ads`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              name: input.name,
              ad_group_id: adGroupId,
              post_id: postId,
              click_url: input.destinationUrl ?? null,
              configured_status: "PAUSED",
            },
          }),
        },
      );
      const adId = firstId(adResponse);
      if (!adId) throw new Error("Reddit ad create returned no id");
      return { success: true, externalCreativeId: `${postId}/${adId}` };
    } catch (error) {
      logger.error("[RedditAds] Creative creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async uploadMedia(
    _credentials: AdAccountCredentials,
    _accountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    try {
      await assertSafeAdMediaUrl(input.url);
      const id = `reddit-url:${mediaFileName({ name: input.name, url: input.url })}`;
      return {
        success: true,
        providerAssetId: id,
        providerAssetUrl: input.url,
        providerAssetResourceName: input.url,
        metadata: { storage: "external_url", type: input.type },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getMediaStatus(
    _credentials: AdAccountCredentials,
    _accountId: string,
    input: { providerAssetResourceName: string },
  ): Promise<AdProviderMediaStatusResult> {
    return {
      success: true,
      providerAssetId: input.providerAssetResourceName,
      providerAssetUrl: input.providerAssetResourceName,
      providerAssetResourceName: input.providerAssetResourceName,
      status: "AVAILABLE",
      ready: true,
    };
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const { accountId, campaignId } = splitRedditCampaignId(externalCampaignId);
    try {
      if (!accountId) {
        throw new Error("Reddit campaign metrics require a composite account/campaign id");
      }
      const end = dateRange?.end ?? new Date();
      const start = dateRange?.start ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const response = await redditRequest<RedditReportRow[]>(
        `/ad_accounts/${encodeURIComponent(accountId)}/reports`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              starts_at: isoHour(start),
              ends_at: isoHour(end),
              fields: ["SPEND", "IMPRESSIONS", "CLICKS", "CONVERSIONS"],
              breakdowns: ["CAMPAIGN_ID"],
              filter: {
                field: "CAMPAIGN_ID",
                operator: "IN",
                values: [campaignId],
              },
              time_zone_id: "UTC",
            },
          }),
        },
      );
      return { success: true, metrics: sumReportRows(response.data ?? []) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
