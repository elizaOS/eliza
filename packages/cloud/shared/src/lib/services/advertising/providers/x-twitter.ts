// X Ads API v12 integration - https://docs.x.com/x-ads-api/introduction

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
  UpdateCampaignInput,
  UploadMediaInput,
} from "../types";

const X_ADS_BASE_URL = "https://ads-api.x.com/12";
const X_UPLOAD_BASE_URL = "https://upload.x.com/1.1";

interface XAdsResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; code?: string }>;
  next_cursor?: string | null;
}

interface XAdsAccount {
  id: string;
  name?: string | null;
}

interface XFundingInstrument {
  id: string;
  entity_status?: string;
}

interface XEntity {
  id?: string;
  id_str?: string;
  tweet_id?: string;
  media_key?: string;
  media_status?: string;
}

interface XPromotableUser {
  user_id: string;
  promotable_user_type?: string;
}

interface XStatsRow {
  id?: string;
  id_data?: Array<{
    metrics?: Record<string, Array<number | null> | null>;
  }>;
}

function consumerKey(): string {
  const value = process.env.X_ADS_CONSUMER_KEY ?? process.env.TWITTER_ADS_CONSUMER_KEY;
  if (!value) throw new Error("X Ads consumer key is not configured");
  return value;
}

function consumerSecret(): string {
  const value = process.env.X_ADS_CONSUMER_SECRET ?? process.env.TWITTER_ADS_CONSUMER_SECRET;
  if (!value) throw new Error("X Ads consumer secret is not configured");
  return value;
}

function tokenSecret(credentials: AdAccountCredentials): string {
  if (!credentials.refreshToken) {
    throw new Error("X Ads OAuth token secret is required as refreshToken");
  }
  return credentials.refreshToken;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function hmacSha1(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return base64(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function oauthHeader(
  method: string,
  url: URL,
  credentials: AdAccountCredentials,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey(),
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const params: Array<[string, string]> = [
    ...url.searchParams.entries(),
    ...Object.entries(oauthParams),
  ];
  params.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    return keyCompare !== 0 ? keyCompare : leftValue.localeCompare(rightValue);
  });
  const normalized = params
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const baseUrl = `${url.origin}${url.pathname}`;
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalized),
  ].join("&");
  const signingKey = `${percentEncode(consumerSecret())}&${percentEncode(tokenSecret(credentials))}`;
  oauthParams.oauth_signature = await hmacSha1(signingKey, signatureBase);
  return `OAuth ${Object.entries(oauthParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

async function xAdsRequest<T>(
  endpoint: string,
  credentials: AdAccountCredentials,
  options: RequestInit & {
    params?: Record<string, string | number | boolean | undefined | null>;
    baseUrl?: string;
  } = {},
): Promise<XAdsResponse<T>> {
  const url = new URL(`${options.baseUrl ?? X_ADS_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const method = options.method ?? "GET";
  const response = await fetch(url.toString(), {
    ...options,
    method,
    headers: {
      Authorization: await oauthHeader(method, url, credentials),
      ...options.headers,
    },
  });
  // error-policy:J3 provider-response parse — empty-body success responses (DELETE/PUT/204) carry no
  // JSON; a non-ok status still throws below, and data-required callers throw on the missing id, so a
  // parse miss never masks a real failure.
  const json = (await response.json().catch(() => ({}))) as XAdsResponse<T>;
  if (!response.ok || json.errors?.length) {
    throw new Error(
      json.errors
        ?.map((error) => error.message || error.code)
        .filter(Boolean)
        .join("; ") || `X Ads API error: ${response.status}`,
    );
  }
  return json;
}

function micros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mapObjective(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "REACH",
    traffic: "WEBSITE_CLICKS",
    engagement: "ENGAGEMENTS",
    leads: "WEBSITE_CLICKS",
    app_promotion: "APP_INSTALLS",
    sales: "WEBSITE_CONVERSIONS",
    conversions: "WEBSITE_CONVERSIONS",
  };
  return mapping[objective] || "WEBSITE_CLICKS";
}

function splitExternalCampaignId(externalCampaignId: string): {
  accountId?: string;
  campaignId: string;
  lineItemId?: string;
} {
  const [accountId, campaignId, lineItemId] = externalCampaignId.split("/");
  if (accountId && campaignId && lineItemId) return { accountId, campaignId, lineItemId };
  if (accountId && campaignId) return { accountId, campaignId };
  return { campaignId: externalCampaignId };
}

function firstId(response: XAdsResponse<XEntity | XEntity[]>): string | undefined {
  if (Array.isArray(response.data)) return response.data[0]?.id ?? response.data[0]?.id_str;
  return response.data?.id ?? response.data?.id_str ?? response.data?.tweet_id;
}

async function firstFundingInstrument(
  credentials: AdAccountCredentials,
  accountId: string,
): Promise<string> {
  const response = await xAdsRequest<XFundingInstrument[]>(
    `/accounts/${encodeURIComponent(accountId)}/funding_instruments`,
    credentials,
    { params: { count: 1, with_deleted: false } },
  );
  const id = response.data?.find((item) => item.entity_status !== "DELETED")?.id;
  if (!id) throw new Error("No active X Ads funding instrument found for ad account");
  return id;
}

async function firstPromotableUser(
  credentials: AdAccountCredentials,
  accountId: string,
): Promise<string> {
  const response = await xAdsRequest<XPromotableUser[]>(
    `/accounts/${encodeURIComponent(accountId)}/promotable_users`,
    credentials,
    { params: { count: 200 } },
  );
  const user =
    response.data?.find((item) => item.promotable_user_type === "FULL") ?? response.data?.[0];
  if (!user?.user_id) throw new Error("No X Ads promotable user found for ad account");
  return user.user_id;
}

function sumMetrics(metrics?: Record<string, Array<number | null> | null>): CampaignMetrics {
  const sum = (key: string): number => {
    const values = metrics?.[key];
    if (!Array.isArray(values)) return 0;
    return values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  };
  const spend = sum("billed_charge_local_micro") / 1_000_000;
  const impressions = sum("impressions");
  const clicks = sum("clicks") || sum("url_clicks") || sum("engagements");
  const conversions = sum("conversion_purchases") || sum("conversion_sign_ups") || 0;
  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
  };
}

export const xTwitterAdsProvider: AdProvider = {
  platform: "x-twitter",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    let accounts: Array<{ id: string; name: string }>;
    try {
      accounts = await this.listAdAccounts(credentials);
    } catch (error) {
      // error-policy:J1 credential-check boundary — surface the transport/auth failure as its own
      // distinct invalid state instead of collapsing it into the "no accounts found" empty case.
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[XTwitterAds] Validation failed", { error: message });
      return { valid: false, error: message };
    }
    if (accounts.length === 0) {
      return { valid: false, error: "No X Ads accounts found or invalid credentials" };
    }
    return { valid: true, accountId: accounts[0].id, accountName: accounts[0].name };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await xAdsRequest<XAdsAccount[]>("/accounts", credentials, {
      params: { count: 1000, with_deleted: false },
    });
    return (response.data ?? []).map((account) => ({
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
      const fundingInstrumentId = await firstFundingInstrument(credentials, accountId);
      const budgetKey =
        input.budgetType === "lifetime"
          ? "total_budget_amount_local_micro"
          : "daily_budget_amount_local_micro";
      const campaignResponse = await xAdsRequest<XEntity>(
        `/accounts/${encodeURIComponent(accountId)}/campaigns`,
        credentials,
        {
          method: "POST",
          params: {
            funding_instrument_id: fundingInstrumentId,
            name: input.name,
            entity_status: "PAUSED",
            budget_optimization: "LINE_ITEM",
            [budgetKey]: micros(input.budgetAmount),
            start_time: input.startDate ? iso(input.startDate) : undefined,
            end_time: input.endDate ? iso(input.endDate) : undefined,
          },
        },
      );
      const campaignId = firstId(campaignResponse);
      if (!campaignId) throw new Error("X Ads campaign create returned no id");
      const lineItemResponse = await xAdsRequest<XEntity>(
        `/accounts/${encodeURIComponent(accountId)}/line_items`,
        credentials,
        {
          method: "POST",
          params: {
            campaign_id: campaignId,
            objective: mapObjective(input.objective),
            product_type: "PROMOTED_TWEETS",
            placements: "ALL_ON_TWITTER",
            entity_status: "PAUSED",
            bid_amount_local_micro: micros(1),
            [budgetKey]: micros(input.budgetAmount),
            start_time: input.startDate ? iso(input.startDate) : undefined,
            end_time: input.endDate ? iso(input.endDate) : undefined,
          },
        },
      );
      const lineItemId = firstId(lineItemResponse);
      if (!lineItemId) throw new Error("X Ads line item create returned no id");
      return { success: true, externalCampaignId: `${accountId}/${campaignId}/${lineItemId}` };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown campaign-create failure into a
      // structured { success:false } result for the caller.
      logger.error("[XTwitterAds] Campaign creation failed", {
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
    const { campaignId, lineItemId } = splitExternalCampaignId(externalCampaignId);
    try {
      const campaignParams: Record<string, string | number> = {};
      if (input.name) campaignParams.name = input.name;
      if (input.startDate) campaignParams.start_time = iso(input.startDate);
      if (input.endDate) campaignParams.end_time = iso(input.endDate);
      if (input.budgetAmount !== undefined) {
        campaignParams.daily_budget_amount_local_micro = micros(input.budgetAmount);
      }
      if (Object.keys(campaignParams).length > 0) {
        const accountId = splitExternalCampaignId(externalCampaignId).accountId;
        if (!accountId) throw new Error("X Ads update requires composite account/campaign id");
        await xAdsRequest(
          `/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
          credentials,
          { method: "PUT", params: campaignParams },
        );
      }
      if (lineItemId && input.budgetAmount !== undefined) {
        const accountId = splitExternalCampaignId(externalCampaignId).accountId;
        if (!accountId) throw new Error("X Ads update requires composite account/campaign id");
        await xAdsRequest(
          `/accounts/${encodeURIComponent(accountId)}/line_items/${encodeURIComponent(lineItemId)}`,
          credentials,
          {
            method: "PUT",
            params: { daily_budget_amount_local_micro: micros(input.budgetAmount) },
          },
        );
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown campaign-update failure into a
      // structured { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId, lineItemId } = splitExternalCampaignId(externalCampaignId);
    try {
      if (!accountId) throw new Error("X Ads pause requires composite account/campaign id");
      if (lineItemId) {
        await xAdsRequest(
          `/accounts/${encodeURIComponent(accountId)}/line_items/${encodeURIComponent(lineItemId)}`,
          credentials,
          { method: "PUT", params: { entity_status: "PAUSED" } },
        );
      }
      await xAdsRequest(
        `/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
        credentials,
        { method: "PUT", params: { entity_status: "PAUSED" } },
      );
      return { success: true, externalCampaignId };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown pause failure into a structured
      // { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId, lineItemId } = splitExternalCampaignId(externalCampaignId);
    try {
      if (!accountId) throw new Error("X Ads activation requires composite account/campaign id");
      await xAdsRequest(
        `/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
        credentials,
        { method: "PUT", params: { entity_status: "ACTIVE" } },
      );
      if (lineItemId) {
        await xAdsRequest(
          `/accounts/${encodeURIComponent(accountId)}/line_items/${encodeURIComponent(lineItemId)}`,
          credentials,
          { method: "PUT", params: { entity_status: "ACTIVE" } },
        );
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown activation failure into a structured
      // { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { accountId, campaignId, lineItemId } = splitExternalCampaignId(externalCampaignId);
    try {
      if (!accountId) throw new Error("X Ads delete requires composite account/campaign id");
      if (lineItemId) {
        await xAdsRequest(
          `/accounts/${encodeURIComponent(accountId)}/line_items/${encodeURIComponent(lineItemId)}`,
          credentials,
          { method: "DELETE" },
        );
      }
      await xAdsRequest(
        `/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
        credentials,
        { method: "DELETE" },
      );
      return { success: true };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown delete failure into a structured
      // { success:false } result for the caller.
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
      const { lineItemId } = splitExternalCampaignId(externalCampaignId);
      if (!lineItemId) throw new Error("X Ads creative creation requires a line item id");
      const asUserId = input.pageId ?? (await firstPromotableUser(credentials, accountId));
      const orderedMedia = [...input.media].sort((left, right) => left.order - right.order);
      const mediaKeys = orderedMedia
        .map((media) => media.providerAssetId)
        .filter((value): value is string => Boolean(value));
      const tweetResponse = await xAdsRequest<XEntity>(
        `/accounts/${encodeURIComponent(accountId)}/tweet`,
        credentials,
        {
          method: "POST",
          params: {
            as_user_id: asUserId,
            text: [input.headline, input.primaryText ?? input.description]
              .filter(Boolean)
              .join("\n\n"),
            media_keys: mediaKeys.length ? mediaKeys.join(",") : undefined,
            trim_user: true,
          },
        },
      );
      const tweetId = firstId(tweetResponse);
      if (!tweetId) throw new Error("X Ads tweet create returned no tweet id");
      const promotedResponse = await xAdsRequest<XEntity[]>(
        `/accounts/${encodeURIComponent(accountId)}/promoted_tweets`,
        credentials,
        {
          method: "POST",
          params: {
            line_item_id: lineItemId,
            tweet_ids: tweetId,
          },
        },
      );
      const promotedTweetId = firstId(promotedResponse);
      if (!promotedTweetId) throw new Error("X Ads promoted tweet create returned no id");
      return { success: true, externalCreativeId: `${tweetId}/${promotedTweetId}` };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown creative-create failure into a
      // structured { success:false } result for the caller.
      logger.error("[XTwitterAds] Creative creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async uploadMedia(
    credentials: AdAccountCredentials,
    accountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    try {
      const media = await downloadAdMedia(input.url, {
        fileName: mediaFileName({ name: input.name, url: input.url, contentType: input.mimeType }),
      });
      const form = new FormData();
      const mediaBytes = media.bytes.slice().buffer as ArrayBuffer;
      form.set("media", new Blob([mediaBytes], { type: media.contentType }), media.fileName);
      form.set("media_category", input.type === "video" ? "TWEET_VIDEO" : "TWEET_IMAGE");
      const uploadResponse = await xAdsRequest<XEntity>("/media/upload.json", credentials, {
        baseUrl: X_UPLOAD_BASE_URL,
        method: "POST",
        body: form,
      });
      const mediaKey = uploadResponse.data?.media_key ?? uploadResponse.data?.id_str;
      if (!mediaKey) throw new Error("X media upload returned no media key");
      const libraryResponse = await xAdsRequest<XEntity>(
        `/accounts/${encodeURIComponent(accountId)}/media_library`,
        credentials,
        {
          method: "POST",
          params: {
            media_key: mediaKey,
            name: input.name ?? media.fileName,
            file_name: media.fileName,
          },
        },
      );
      return {
        success: true,
        providerAssetId: mediaKey,
        providerAssetUrl: input.url,
        providerAssetResourceName: libraryResponse.data?.media_key ?? mediaKey,
        metadata: { mediaStatus: libraryResponse.data?.media_status },
      };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown media-upload failure into a
      // structured { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getMediaStatus(
    credentials: AdAccountCredentials,
    accountId: string,
    input: { providerAssetResourceName: string },
  ): Promise<AdProviderMediaStatusResult> {
    try {
      const response = await xAdsRequest<XEntity>(
        `/accounts/${encodeURIComponent(accountId)}/media_library/${encodeURIComponent(
          input.providerAssetResourceName,
        )}`,
        credentials,
      );
      const status = response.data?.media_status ?? "UNKNOWN";
      return {
        success: true,
        providerAssetId: input.providerAssetResourceName,
        providerAssetResourceName: input.providerAssetResourceName,
        status,
        ready: status === "TRANSCODE_COMPLETED" || status === "READY",
      };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown media-status failure into a
      // structured { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const { accountId, lineItemId } = splitExternalCampaignId(externalCampaignId);
    try {
      if (!accountId || !lineItemId) {
        throw new Error("X Ads metrics require a composite account/campaign/line-item id");
      }
      const end = dateRange?.end ?? new Date();
      const start = dateRange?.start ?? new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      const response = await xAdsRequest<XStatsRow[]>(
        `/stats/accounts/${encodeURIComponent(accountId)}`,
        credentials,
        {
          params: {
            entity: "LINE_ITEM",
            entity_ids: lineItemId,
            start_time: iso(start),
            end_time: iso(end),
            granularity: "TOTAL",
            placement: "ALL_ON_TWITTER",
            metric_groups: "ENGAGEMENT,BILLING,WEB_CONVERSION",
          },
        },
      );
      const metrics = response.data?.[0]?.id_data?.[0]?.metrics;
      return { success: true, metrics: sumMetrics(metrics) };
    } catch (error) {
      // error-policy:J1 provider boundary — translate a thrown metrics-fetch failure into a
      // structured { success:false } result for the caller.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
