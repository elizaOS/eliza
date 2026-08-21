/**
 * Implements the Google Ads provider boundary, including bounded REST calls and resumable media
 * uploads against provider-issued authorities.
 */

import { ElizaError } from "@elizaos/core";
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
const GOOGLE_ADS_LIST_ACCOUNTS_TIMEOUT_MS = 60_000;
const GOOGLE_ADS_UPLOAD_TIMEOUT_MS = 60_000;
const MAX_GOOGLE_ADS_ACCESSIBLE_CUSTOMERS = 10_000;
const GOOGLE_ADS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function bufferGoogleAdsResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > GOOGLE_ADS_RESPONSE_MAX_BYTES) {
      const error = new ElizaError("Google Ads response exceeds the byte limit", {
        code: "GOOGLE_ADS_RESPONSE_TOO_LARGE",
        context: { declaredBytes, maxBytes: GOOGLE_ADS_RESPONSE_MAX_BYTES },
      });
      if (response.body) {
        try {
          await response.body.cancel(error);
        } catch (cause) {
          // error-policy:J6 The response already failed closed; cancellation only releases the
          // unread transport body.
          logger.debug("[GoogleAds] Failed to cancel declared-oversize response body", { cause });
        }
      }
      throw error;
    }
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const cancelBody = (): void => {
    reader.cancel(signal.reason).catch((cause: unknown) => {
      // error-policy:J6 The hop already failed; cancellation only releases its response stream.
      logger.debug("[GoogleAds] Failed to cancel aborted response body", { cause });
    });
  };
  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > GOOGLE_ADS_RESPONSE_MAX_BYTES) {
        const error = new ElizaError("Google Ads response exceeds the byte limit", {
          code: "GOOGLE_ADS_RESPONSE_TOO_LARGE",
          context: { receivedBytes, maxBytes: GOOGLE_ADS_RESPONSE_MAX_BYTES },
        });
        try {
          await reader.cancel(error);
        } catch (cause) {
          // error-policy:J6 The bounded read already failed; cancellation only releases the stream.
          logger.debug("[GoogleAds] Failed to cancel oversized response body", { cause });
        }
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelBody);
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body.buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Bound every Google Ads REST hop so a hung or rate-limited API cannot pin the
 * ad-provider worker indefinitely. Caller cancellation and the deadline are
 * composed so neither can disable the other.
 */
export async function googleAdsFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = GOOGLE_ADS_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new ElizaError("Google Ads timeout must be a positive timer-safe integer", {
      code: "INVALID_GOOGLE_ADS_TIMEOUT",
      context: { timeoutMs },
    });
  }

  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onCallerAbort = (): void =>
    abort(
      init?.signal?.reason ?? new DOMException("The Google Ads request was aborted.", "AbortError"),
    );
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (init?.signal?.aborted) onCallerAbort();
  const timeoutId = setTimeout(
    () => abort(new DOMException("Google Ads API request timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      abortPromise,
    ]);
    return await Promise.race([bufferGoogleAdsResponse(response, controller.signal), abortPromise]);
  } finally {
    clearTimeout(timeoutId);
    init?.signal?.removeEventListener("abort", onCallerAbort);
  }
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

function accessibleCustomerIds(resourceNames: unknown): string[] {
  if (!Array.isArray(resourceNames)) {
    throw new ElizaError("Google Ads accessible-customer response is malformed", {
      code: "INVALID_GOOGLE_ADS_CUSTOMER_RESOURCES",
    });
  }
  if (resourceNames.length > MAX_GOOGLE_ADS_ACCESSIBLE_CUSTOMERS) {
    throw new ElizaError(
      `Google Ads returned more than ${MAX_GOOGLE_ADS_ACCESSIBLE_CUSTOMERS} accessible customers`,
      {
        code: "GOOGLE_ADS_CUSTOMER_LIMIT_EXCEEDED",
        context: {
          count: resourceNames.length,
          maxCustomers: MAX_GOOGLE_ADS_ACCESSIBLE_CUSTOMERS,
        },
      },
    );
  }

  const seen = new Set<string>();
  return resourceNames.map((resourceName) => {
    if (typeof resourceName !== "string" || !/^customers\/\d+$/.test(resourceName)) {
      throw new ElizaError("Google Ads accessible-customer response contains an invalid resource", {
        code: "INVALID_GOOGLE_ADS_CUSTOMER_RESOURCES",
        context: { resourceName },
      });
    }
    const customerId = resourceName.slice("customers/".length);
    if (seen.has(customerId)) {
      throw new ElizaError(
        "Google Ads accessible-customer response contains a duplicate resource",
        {
          code: "INVALID_GOOGLE_ADS_CUSTOMER_RESOURCES",
          context: { customerId },
        },
      );
    }
    seen.add(customerId);
    return customerId;
  });
}

function googleAdsUploadUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    // error-policy:J2 Preserve the parser cause while adding provider-boundary context.
    throw new ElizaError("Google Ads video upload returned an invalid upload URL", {
      code: "INVALID_GOOGLE_ADS_UPLOAD_URL",
      cause,
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "googleads.googleapis.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    throw new ElizaError("Google Ads video upload returned an untrusted upload URL", {
      code: "INVALID_GOOGLE_ADS_UPLOAD_URL",
      context: {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
      },
    });
  }
  return parsed;
}

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

function truncateGoogleText(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars);
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
    const deadline = new AbortController();
    const timeoutId = setTimeout(() => {
      deadline.abort(new DOMException("Google Ads account listing timed out", "TimeoutError"));
    }, GOOGLE_ADS_LIST_ACCOUNTS_TIMEOUT_MS);
    try {
      const response = await googleAdsFetch(
        `${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`,
        {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
          },
          signal: deadline.signal,
        },
      );

      if (!response.ok) {
        throw new Error("Failed to list Google Ads accounts");
      }

      const data = (await response.json()) as { resourceNames?: unknown };
      const customerIds = accessibleCustomerIds(data.resourceNames);

      // Get details for each customer
      const accounts: Array<{ id: string; name: string }> = [];

      for (const customerId of customerIds) {
        const customerResponse = await googleAdsRequest<
          GoogleAdsSearchStreamResponse<{
            customer: GoogleAdsCustomer;
          }>
        >("/googleAds:searchStream", credentials.accessToken, customerId, {
          method: "POST",
          body: JSON.stringify({
            query: `SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1`,
          }),
          signal: deadline.signal,
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
    } finally {
      clearTimeout(timeoutId);
    }
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
              startDate: input.startDate
                ? input.startDate.toISOString().split("T")[0].replace(/-/g, "")
                : undefined,
              endDate: input.endDate
                ? input.endDate.toISOString().split("T")[0].replace(/-/g, "")
                : undefined,
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

    if (input.startDate) {
      updateFields.startDate = input.startDate.toISOString().split("T")[0].replace(/-/g, "");
      updateMask.push("startDate");
    }

    if (input.endDate) {
      updateFields.endDate = input.endDate.toISOString().split("T")[0].replace(/-/g, "");
      updateMask.push("endDate");
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

    const marketingImage = input.media.find(
      (media) => media.type === "image" && media.providerAssetId,
    );
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
                  text: truncateGoogleText(input.headline || input.name, 30),
                },
              ],
              longHeadline: {
                text: truncateGoogleText(input.headline || input.name, 90),
              },
              descriptions: [
                {
                  text: truncateGoogleText(
                    input.primaryText || input.description || input.name,
                    90,
                  ),
                },
              ],
              businessName: truncateGoogleText(input.name, 25),
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
        const deadline = new AbortController();
        const timeoutId = setTimeout(() => {
          deadline.abort(new DOMException("Google Ads video upload timed out", "TimeoutError"));
        }, GOOGLE_ADS_UPLOAD_TIMEOUT_MS);
        try {
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
              signal: deadline.signal,
            },
          );
          if (!startResponse.ok) {
            throw new Error(`Google Ads video upload initiation failed (${startResponse.status})`);
          }

          const uploadUrl = startResponse.headers.get("x-goog-upload-url");
          if (!uploadUrl) {
            throw new Error("Google Ads video upload did not return an upload URL");
          }
          const parsedUploadUrl = googleAdsUploadUrl(uploadUrl);

          const videoBody = downloaded.bytes.buffer.slice(
            downloaded.bytes.byteOffset,
            downloaded.bytes.byteOffset + downloaded.bytes.byteLength,
          ) as ArrayBuffer;
          const finalizeResponse = await googleAdsFetch(parsedUploadUrl, {
            method: "PUT",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              "Content-Type": downloaded.contentType,
              "Content-Length": String(downloaded.bytes.byteLength),
              "X-Goog-Upload-Offset": "0",
              "X-Goog-Upload-Command": "upload, finalize",
            },
            body: videoBody,
            signal: deadline.signal,
          });
          const responseText = await finalizeResponse.text();
          if (!finalizeResponse.ok) {
            throw new Error(`Google Ads video upload failed (${finalizeResponse.status})`);
          }
          let data: { resourceName?: string } = {};
          if (responseText !== "") {
            try {
              data = JSON.parse(responseText) as { resourceName?: string };
            } catch (cause) {
              // error-policy:J2 Preserve the parse cause while adding provider-boundary context.
              throw new ElizaError("Google Ads video upload returned invalid JSON", {
                code: "INVALID_GOOGLE_ADS_UPLOAD_RESPONSE",
                cause,
              });
            }
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
        } finally {
          clearTimeout(timeoutId);
        }
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

    const query = `
      SELECT
        campaign.id,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE campaign.id = '${campaignId}'
        AND segments.date BETWEEN '${startDate.toISOString().split("T")[0]}' AND '${endDate.toISOString().split("T")[0]}'
    `;

    const response = await googleAdsRequest<{
      results: Array<{
        campaign: { id: string };
        metrics: {
          impressions: string;
          clicks: string;
          costMicros: string;
          conversions: string;
        };
      }>;
    }>("/googleAds:searchStream", credentials.accessToken, accountId, {
      method: "POST",
      body: JSON.stringify({ query }),
    });

    const result = response.results?.[0];
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
      conversions: parseInt(result.metrics.conversions || "0"),
    };

    return { success: true, metrics };
  },
};
