// Google Ads API integration - https://developers.google.com/google-ads/api

import { logger } from "../../../utils/logger";
import { downloadAdMedia, mediaFileName } from "../media-utils";
import type {
  AdAccountCredentials,
  AdProvider,
  AdProviderCampaignResult,
  AdProviderCreativeResult,
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

const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_ADS_RESUMABLE_UPLOAD_BASE_URL = `https://googleads.googleapis.com/resumable/upload/${GOOGLE_ADS_API_VERSION}`;

const GOOGLE_ADS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Google Ads REST hop so a hung or rate-limited API cannot pin the
 * ad-provider worker indefinitely. A caller-provided abort signal wins.
 */
export function googleAdsFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = GOOGLE_ADS_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

interface GoogleAdsError {
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

interface GoogleAdsCustomer {
  resourceName: string;
  id: string;
  descriptiveName: string;
}

type GoogleAdsSearchStreamResponse<T> = { results?: T[] } | Array<{ results?: T[] }>;

async function googleAdsRequest<T>(
  endpoint: string,
  accessToken: string,
  customerId: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${GOOGLE_ADS_BASE_URL}/customers/${customerId}${endpoint}`;

  const response = await googleAdsFetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
      ...options.headers,
    },
  });

  const json = await response.json();

  if (!response.ok) {
    const error = json as GoogleAdsError;
    throw new Error(error.error?.message || `Google Ads API error: ${response.status}`);
  }

  return json as T;
}

function mapObjectiveToGoogleAds(objective: string): {
  advertisingChannelType: string;
  advertisingChannelSubType?: string;
} {
  const mapping: Record<
    string,
    { advertisingChannelType: string; advertisingChannelSubType?: string }
  > = {
    awareness: { advertisingChannelType: "DISPLAY" },
    traffic: { advertisingChannelType: "SEARCH" },
    engagement: { advertisingChannelType: "DISPLAY" },
    leads: { advertisingChannelType: "SEARCH" },
    app_promotion: {
      advertisingChannelType: "MULTI_CHANNEL",
      advertisingChannelSubType: "APP_CAMPAIGN",
    },
    sales: { advertisingChannelType: "SHOPPING" },
    conversions: { advertisingChannelType: "PERFORMANCE_MAX" },
  };

  return mapping[objective] || { advertisingChannelType: "SEARCH" };
}

export function mapBidControlsToGoogleCampaign(
  input: Pick<CreateCampaignInput, "bidStrategy" | "optimizationGoal">,
): Record<string, unknown> {
  const effectiveGoal =
    input.optimizationGoal ??
    (input.bidStrategy === "cpa"
      ? "conversions"
      : input.bidStrategy === "cpc"
        ? "clicks"
        : "reach");

  if (effectiveGoal === "conversions") {
    return { maximizeConversions: {} };
  }

  if (effectiveGoal === "clicks") {
    return { manualCpc: {} };
  }

  return { manualCpm: {} };
}

function splitGoogleCampaignId(
  accountId: string,
  externalCampaignId: string,
): { customerId: string; campaignId: string } {
  const parts = externalCampaignId.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { customerId: parts[0], campaignId: parts[1] };
  }
  return { customerId: accountId, campaignId: externalCampaignId };
}

function toGoogleImageMimeType(contentType: string): string | undefined {
  if (contentType === "image/jpeg") return "IMAGE_JPEG";
  if (contentType === "image/png") return "IMAGE_PNG";
  if (contentType === "image/gif") return "IMAGE_GIF";
  return undefined;
}

function extractYouTubeVideoId(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return normalizeYouTubeVideoId(url.pathname.slice(1));
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      return normalizeYouTubeVideoId(url.searchParams.get("v") ?? "");
    }
    // error-policy:J3 rawUrl is caller-supplied; a malformed URL is invalid input,
    // reported as "no extractable video id" — not a swallowed provider/transport failure.
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeYouTubeVideoId(value: string): string | undefined {
  const id = value.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : undefined;
}

/**
 * Google Ads reads campaign dates and `segments.date` in the serving
 * customer's time zone, so every day boundary is computed in that zone. The
 * field is immutable on the customer, so one lookup per customer is enough.
 */
const googleCustomerTimeZones = new Map<string, Promise<string>>();

function googleCustomerTimeZone(accessToken: string, customerId: string): Promise<string> {
  let pending = googleCustomerTimeZones.get(customerId);
  if (!pending) {
    pending = googleAdsRequest<GoogleAdsSearchStreamResponse<{ customer: { timeZone?: string } }>>(
      "/googleAds:searchStream",
      accessToken,
      customerId,
      {
        method: "POST",
        body: JSON.stringify({ query: "SELECT customer.time_zone FROM customer LIMIT 1" }),
      },
    ).then((response) => {
      const timeZone = firstGoogleAdsSearchResult(response)?.customer.timeZone;
      if (!timeZone) {
        throw new Error(`Google Ads customer ${customerId} reports no time zone`);
      }
      return timeZone;
    });
    googleCustomerTimeZones.set(customerId, pending);
    pending.catch(() => googleCustomerTimeZones.delete(customerId));
  }
  return pending;
}

/** Calendar day of `date` in `timeZone` as `YYYY-MM-DD`. */
function googleAccountDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Campaign `start_date_time`/`end_date_time` at daily granularity (Google Ads API v23+). */
function googleCampaignDateTimes(
  input: { startDate?: Date; endDate?: Date },
  timeZone: string,
): { startDateTime?: string; endDateTime?: string } {
  return {
    ...(input.startDate
      ? { startDateTime: `${googleAccountDay(input.startDate, timeZone)} 00:00:00` }
      : {}),
    ...(input.endDate
      ? { endDateTime: `${googleAccountDay(input.endDate, timeZone)} 23:59:59` }
      : {}),
  };
}

function firstGoogleAdsSearchResult<T>(response: GoogleAdsSearchStreamResponse<T>): T | undefined {
  if (Array.isArray(response)) {
    for (const batch of response) {
      const result = batch.results?.[0];
      if (result) return result;
    }
    return undefined;
  }
  return response.results?.[0];
}

async function createGoogleYouTubeVideoAsset(
  credentials: AdAccountCredentials,
  accountId: string,
  input: { name?: string; videoId: string },
): Promise<AdProviderMediaUploadResult> {
  const response = await googleAdsRequest<{
    results: Array<{ resourceName: string }>;
  }>("/assets:mutate", credentials.accessToken, accountId, {
    method: "POST",
    body: JSON.stringify({
      operations: [
        {
          create: {
            name: input.name || `YouTube video ${input.videoId}`,
            type: "YOUTUBE_VIDEO",
            youtubeVideoAsset: {
              youtubeVideoId: input.videoId,
            },
          },
        },
      ],
    }),
  });

  const resourceName = response.results?.[0]?.resourceName;
  if (!resourceName) {
    return {
      success: false,
      error: "Google Ads YouTube video asset creation returned no asset resource name",
    };
  }

  return {
    success: true,
    providerAssetId: resourceName,
    providerAssetResourceName: resourceName,
    metadata: { uploadType: "youtube_video_asset", youtubeVideoId: input.videoId },
  };
}

export const googleAdsProvider: AdProvider = {
  platform: "google",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      return {
        valid: false,
        error: "Google Ads developer token not configured",
      };
    }

    // List accessible customers to validate token
    const response = await googleAdsFetch(
      `${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        },
      },
    );

    if (!response.ok) {
      return {
        valid: false,
        error: "Invalid Google Ads credentials",
      };
    }

    const data = (await response.json()) as { resourceNames: string[] };
    const customerId = data.resourceNames?.[0]?.replace("customers/", "");

    return {
      valid: true,
      accountId: customerId,
      accountName: "Google Ads Account",
    };
  },

  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }> {
    const response = await googleAdsFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to refresh Google token");
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await googleAdsFetch(
      `${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
        },
      },
    );

    if (!response.ok) {
      throw new Error("Failed to list Google Ads accounts");
    }

    const data = (await response.json()) as { resourceNames: string[] };

    // Get details for each customer
    const accounts: Array<{ id: string; name: string }> = [];

    for (const resourceName of data.resourceNames || []) {
      const customerId = resourceName.replace("customers/", "");

      const customerResponse = await googleAdsRequest<
        GoogleAdsSearchStreamResponse<{
          customer: GoogleAdsCustomer;
        }>
      >("/googleAds:searchStream", credentials.accessToken, customerId, {
        method: "POST",
        body: JSON.stringify({
          query: `SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1`,
        }),
      });

      const row = firstGoogleAdsSearchResult(customerResponse);
      if (row) {
        const customer = row.customer;
        accounts.push({
          id: customer.id,
          name: customer.descriptiveName || `Account ${customer.id}`,
        });
      }
    }

    return accounts;
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    logger.info("[GoogleAds] Creating campaign", {
      accountId,
      name: input.name,
      objective: input.objective,
    });

    const channelConfig = mapObjectiveToGoogleAds(input.objective);
    const campaignDates =
      input.startDate || input.endDate
        ? googleCampaignDateTimes(
            input,
            await googleCustomerTimeZone(credentials.accessToken, accountId),
          )
        : {};

    // Create campaign budget first
    const budgetMutateResponse = await googleAdsRequest<{
      results: Array<{ resourceName: string }>;
    }>("/campaignBudgets:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: `${input.name} - Budget`,
              deliveryMethod: "STANDARD",
              amountMicros: Math.round(input.budgetAmount * 1_000_000).toString(),
              ...(input.budgetType === "daily"
                ? {}
                : {
                    totalAmountMicros: Math.round(input.budgetAmount * 1_000_000).toString(),
                  }),
            },
          },
        ],
      }),
    });

    const budgetResourceName = budgetMutateResponse.results?.[0]?.resourceName;
    if (!budgetResourceName) {
      return { success: false, error: "Failed to create campaign budget" };
    }

    // Create campaign
    const campaignMutateResponse = await googleAdsRequest<{
      results: Array<{ resourceName: string }>;
    }>("/campaigns:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: input.name,
              advertisingChannelType: channelConfig.advertisingChannelType,
              advertisingChannelSubType: channelConfig.advertisingChannelSubType,
              status: "PAUSED",
              campaignBudget: budgetResourceName,
              ...mapBidControlsToGoogleCampaign(input),
              ...campaignDates,
            },
          },
        ],
      }),
    });

    const campaignResourceName = campaignMutateResponse.results?.[0]?.resourceName;
    if (!campaignResourceName) {
      return { success: false, error: "Failed to create campaign" };
    }

    const campaignId = campaignResourceName.split("/").pop();

    logger.info("[GoogleAds] Campaign created", {
      campaignId,
      resourceName: campaignResourceName,
    });

    return {
      success: true,
      externalCampaignId: `${accountId}/${campaignId}`,
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
        error: "Invalid campaign ID format (expected accountId/campaignId)",
      };
    }
    const [accountId, campaignId] = parts;

    const updateFields: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (input.name) {
      updateFields.name = input.name;
      updateMask.push("name");
    }

    if (input.startDate || input.endDate) {
      const timeZone = await googleCustomerTimeZone(credentials.accessToken, accountId);
      for (const [field, value] of Object.entries(googleCampaignDateTimes(input, timeZone))) {
        updateFields[field] = value;
        updateMask.push(field);
      }
    }

    await googleAdsRequest("/campaigns:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            updateMask: updateMask.join(","),
            update: {
              resourceName: `customers/${accountId}/campaigns/${campaignId}`,
              ...updateFields,
            },
          },
        ],
      }),
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
    const [accountId, campaignId] = parts;

    await googleAdsRequest("/campaigns:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            updateMask: "status",
            update: {
              resourceName: `customers/${accountId}/campaigns/${campaignId}`,
              status: "PAUSED",
            },
          },
        ],
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
    const [accountId, campaignId] = parts;

    await googleAdsRequest("/campaigns:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            updateMask: "status",
            update: {
              resourceName: `customers/${accountId}/campaigns/${campaignId}`,
              status: "ENABLED",
            },
          },
        ],
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
    const [accountId, campaignId] = parts;

    // Google Ads doesn't allow deletion, only removal (status = REMOVED)
    await googleAdsRequest("/campaigns:mutate", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            updateMask: "status",
            update: {
              resourceName: `customers/${accountId}/campaigns/${campaignId}`,
              status: "REMOVED",
            },
          },
        ],
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
    logger.info("[GoogleAds] Creating creative", {
      accountId,
      campaignId: externalCampaignId,
      name: input.name,
    });
    const { customerId, campaignId } = splitGoogleCampaignId(accountId, externalCampaignId);
    const marketingImage = input.media.find(
      (media) => media.type === "image" && media.providerAssetId,
    );
    const displayHeadline = input.headline || input.name;
    const displayDescription = input.primaryText || input.description || input.name;
    if (
      marketingImage?.providerAssetId &&
      input.destinationUrl &&
      (Array.from(displayHeadline).length > 30 ||
        Array.from(displayDescription).length > 90 ||
        Array.from(input.name).length > 25)
    ) {
      return {
        success: false,
        error:
          "Google responsive display text exceeds a provider field limit (headline 30, description 90, business name 25 characters); nothing was created",
      };
    }

    // Create ad group first
    const adGroupResponse = await googleAdsRequest<{
      results: Array<{ resourceName: string }>;
    }>("/adGroups:mutate", credentials.accessToken, customerId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: `${input.name} - Ad Group`,
              campaign: `customers/${customerId}/campaigns/${campaignId}`,
              type: input.media.some((media) => media.type === "image" && media.providerAssetId)
                ? "DISPLAY_STANDARD"
                : "SEARCH_STANDARD",
              status: "PAUSED",
              cpcBidMicros: "1000000", // $1 default bid
            },
          },
        ],
      }),
    });

    const adGroupResourceName = adGroupResponse.results?.[0]?.resourceName;
    if (!adGroupResourceName) {
      return { success: false, error: "Failed to create ad group" };
    }

    const youtubeVideo = input.media.find(
      (media) =>
        media.type === "video" &&
        media.providerAssetId?.startsWith(`customers/${customerId}/assets/`),
    );
    const ad =
      marketingImage?.providerAssetId && input.destinationUrl
        ? {
            responsiveDisplayAd: {
              marketingImages: [{ asset: marketingImage.providerAssetId }],
              squareMarketingImages: [{ asset: marketingImage.providerAssetId }],
              headlines: [
                {
                  text: displayHeadline,
                },
              ],
              longHeadline: {
                text: displayHeadline,
              },
              descriptions: [
                {
                  text: displayDescription,
                },
              ],
              businessName: input.name,
              ...(youtubeVideo?.providerAssetId
                ? { youtubeVideos: [{ asset: youtubeVideo.providerAssetId }] }
                : {}),
            },
            finalUrls: [input.destinationUrl],
          }
        : {
            responsiveSearchAd: {
              headlines: [
                { text: input.headline || input.name },
                { text: input.description || "Learn More" },
                { text: input.callToAction || "Get Started" },
              ],
              descriptions: [
                { text: input.primaryText || input.description || "" },
                { text: `Visit ${input.destinationUrl || "our site"}` },
              ],
            },
            finalUrls: [input.destinationUrl || ""],
          };

    // Create ad
    const adResponse = await googleAdsRequest<{
      results: Array<{ resourceName: string }>;
    }>("/adGroupAds:mutate", credentials.accessToken, customerId, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            create: {
              adGroup: adGroupResourceName,
              status: "PAUSED",
              ad,
            },
          },
        ],
      }),
    });

    const adResourceName = adResponse.results?.[0]?.resourceName;
    if (!adResourceName) {
      return { success: false, error: "Failed to create ad" };
    }

    const creativeId = adResourceName.split("/").pop();

    return {
      success: true,
      externalCreativeId: creativeId,
    };
  },

  async uploadMedia(credentials: AdAccountCredentials, accountId: string, input: UploadMediaInput) {
    try {
      if (input.type === "video") {
        const youtubeVideoId = extractYouTubeVideoId(input.url);
        if (youtubeVideoId) {
          return await createGoogleYouTubeVideoAsset(credentials, accountId, {
            name: input.name,
            videoId: youtubeVideoId,
          });
        }

        const downloaded = await downloadAdMedia(input.url, {
          maxBytes: 100 * 1024 * 1024,
          allowedContentTypes: ["video/mp4", "video/quicktime", "video/webm"],
          fileName: mediaFileName({
            name: input.name,
            url: input.url,
            contentType: input.mimeType,
            fallbackExtension: "mp4",
          }),
        });

        const headers = {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
          "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(downloaded.bytes.byteLength),
          "X-Goog-Upload-Header-Content-Type": downloaded.contentType,
        };
        const startResponse = await googleAdsFetch(
          `${GOOGLE_ADS_RESUMABLE_UPLOAD_BASE_URL}/customers/${accountId}/youTubeVideoUploads:create`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              customer_id: accountId,
              you_tube_video_upload: {
                video_title: input.name || downloaded.fileName,
                video_description: input.name || downloaded.fileName,
                video_privacy: "UNLISTED",
              },
            }),
          },
        );
        if (!startResponse.ok) {
          throw new Error(`Google Ads video upload initiation failed (${startResponse.status})`);
        }

        const uploadUrl = startResponse.headers.get("x-goog-upload-url");
        if (!uploadUrl) {
          throw new Error("Google Ads video upload did not return an upload URL");
        }

        const videoBody = downloaded.bytes.buffer.slice(
          downloaded.bytes.byteOffset,
          downloaded.bytes.byteOffset + downloaded.bytes.byteLength,
        ) as ArrayBuffer;
        const finalizeResponse = await googleAdsFetch(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": downloaded.contentType,
            "Content-Length": String(downloaded.bytes.byteLength),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
          },
          body: videoBody,
        });
        // error-policy:J3 finalize body may be empty/non-JSON; the !ok check below still
        // surfaces HTTP failures, and a 2xx with no resourceName reports an explicit failure.
        const data = (await finalizeResponse.json().catch(() => ({}))) as {
          resourceName?: string;
        };
        if (!finalizeResponse.ok) {
          throw new Error(`Google Ads video upload failed (${finalizeResponse.status})`);
        }
        if (!data.resourceName) {
          return {
            success: false,
            error: "Google Ads video upload returned no resource name",
            metadata: { response: data },
          };
        }

        return {
          success: true,
          providerAssetId: data.resourceName,
          providerAssetUrl: downloaded.url,
          providerAssetResourceName: data.resourceName,
          metadata: {
            fileName: downloaded.fileName,
            contentType: downloaded.contentType,
            sizeBytes: downloaded.bytes.byteLength,
            uploadType: "youtube_video_upload",
            state: "UPLOADED",
          },
        };
      }

      const downloaded = await downloadAdMedia(input.url, {
        maxBytes: 5 * 1024 * 1024,
        allowedContentTypes: ["image/jpeg", "image/png", "image/gif"],
        fileName: mediaFileName({
          name: input.name,
          url: input.url,
          contentType: input.mimeType,
          fallbackExtension: "jpg",
        }),
      });

      const mimeType = toGoogleImageMimeType(downloaded.contentType);
      const response = await googleAdsRequest<{
        results: Array<{ resourceName: string }>;
      }>("/assets:mutate", credentials.accessToken, accountId, {
        method: "POST",
        body: JSON.stringify({
          operations: [
            {
              create: {
                name: input.name || downloaded.fileName,
                type: "IMAGE",
                imageAsset: {
                  data: downloaded.base64,
                  ...(mimeType ? { mimeType } : {}),
                  fileSize: String(downloaded.bytes.byteLength),
                },
              },
            },
          ],
        }),
      });

      const resourceName = response.results?.[0]?.resourceName;
      if (!resourceName) {
        return { success: false, error: "Google Ads image upload returned no asset resource name" };
      }

      return {
        success: true,
        providerAssetId: resourceName,
        providerAssetUrl: downloaded.url,
        providerAssetResourceName: resourceName,
        metadata: {
          fileName: downloaded.fileName,
          contentType: downloaded.contentType,
          sizeBytes: downloaded.bytes.byteLength,
        },
      };
      // error-policy:J1 AdProvider boundary translates a failed upload/download/parse into a
      // structured failure result (success:false) — never a fabricated success.
    } catch (error) {
      logger.error("[GoogleAds] Media upload failed", {
        accountId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Google Ads media upload failed",
      };
    }
  },

  async getMediaStatus(
    credentials: AdAccountCredentials,
    accountId: string,
    input: GetMediaStatusInput,
  ) {
    try {
      if (!input.providerAssetResourceName.includes("/youTubeVideoUploads/")) {
        return {
          success: true,
          providerAssetId: input.providerAssetResourceName,
          providerAssetResourceName: input.providerAssetResourceName,
          status: "AVAILABLE",
          ready: true,
        };
      }
      if (
        !/^customers\/\d+\/youTubeVideoUploads\/[a-zA-Z0-9_-]+$/.test(
          input.providerAssetResourceName,
        )
      ) {
        return {
          success: false,
          error: "Invalid Google Ads video upload resource name",
        };
      }

      const response = await googleAdsRequest<
        GoogleAdsSearchStreamResponse<{
          youTubeVideoUpload: {
            resourceName?: string;
            videoId?: string;
            state?: string;
          };
        }>
      >("/googleAds:searchStream", credentials.accessToken, accountId, {
        method: "POST",
        body: JSON.stringify({
          query: `
            SELECT
              you_tube_video_upload.resource_name,
              you_tube_video_upload.video_id,
              you_tube_video_upload.state
            FROM you_tube_video_upload
            WHERE you_tube_video_upload.resource_name = '${input.providerAssetResourceName}'
          `,
        }),
      });

      const upload = firstGoogleAdsSearchResult(response)?.youTubeVideoUpload;
      if (!upload) {
        return {
          success: false,
          error: "Google Ads video upload was not found",
        };
      }

      const ready = upload.state === "PROCESSED" && Boolean(upload.videoId);
      return {
        success: true,
        providerAssetId: input.providerAssetResourceName,
        providerAssetResourceName: upload.resourceName ?? input.providerAssetResourceName,
        providerAssetUrl:
          ready && upload.videoId ? `https://www.youtube.com/watch?v=${upload.videoId}` : undefined,
        status: upload.state,
        ready,
        metadata: {
          youtubeVideoId: upload.videoId,
          youtubeUrl:
            ready && upload.videoId
              ? `https://www.youtube.com/watch?v=${upload.videoId}`
              : undefined,
        },
      };
      // error-policy:J1 AdProvider boundary translates a failed status fetch/parse into a
      // structured failure result (success:false) — distinct from a resolved not-ready status.
    } catch (error) {
      logger.error("[GoogleAds] Media status failed", {
        accountId,
        providerAssetResourceName: input.providerAssetResourceName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Google Ads media status failed",
      };
    }
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
    const [accountId, campaignId] = parts;

    const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.end || new Date();
    const timeZone = await googleCustomerTimeZone(credentials.accessToken, accountId);

    const query = `
      SELECT
        campaign.id,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE campaign.id = '${campaignId}'
        AND segments.date BETWEEN '${googleAccountDay(startDate, timeZone)}' AND '${googleAccountDay(endDate, timeZone)}'
    `;

    const response = await googleAdsRequest<
      GoogleAdsSearchStreamResponse<{
        campaign: { id: string };
        metrics: {
          impressions: string;
          clicks: string;
          costMicros: string;
          conversions: string;
        };
      }>
    >("/googleAds:searchStream", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({ query }),
    });

    const result = firstGoogleAdsSearchResult(response);
    if (!result) {
      return {
        success: true,
        metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
      };
    }

    const metrics: CampaignMetrics = {
      spend: parseInt(result.metrics.costMicros || "0") / 1_000_000,
      impressions: parseInt(result.metrics.impressions || "0"),
      clicks: parseInt(result.metrics.clicks || "0"),
      // Keep the existing integer-count contract: updateMetrics persists this
      // value in ad_campaigns.total_conversions (an integer column).
      conversions: Number.parseInt(result.metrics.conversions || "0", 10),
    };

    return { success: true, metrics };
  },
};
