// LinkedIn Marketing API integration (versioned REST) -
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns

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

const LINKEDIN_API_BASE_URL = "https://api.linkedin.com/rest";
const LINKEDIN_OAUTH_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
// "Worldwide" geo URN — the default include location when no targeting is given
// (LinkedIn requires at least one location facet on every campaign).
const LINKEDIN_WORLDWIDE_GEO = "urn:li:geo:92000000";

function linkedinVersion(): string {
  return process.env.LINKEDIN_ADS_API_VERSION ?? "202606";
}

interface LinkedInErrorBody {
  message?: string;
  code?: string;
  serviceErrorCode?: number;
  status?: number;
}

interface LinkedInCollection<T> {
  elements?: T[];
  metadata?: { nextPageToken?: string | null };
  paging?: { start?: number; count?: number };
}

interface LinkedInAdAccount {
  id: number | string;
  name?: string | null;
  status?: string;
  currency?: string | null;
  reference?: string | null;
}

interface LinkedInCampaign {
  id?: number | string;
  dailyBudget?: { amount: string; currencyCode: string };
  totalBudget?: { amount: string; currencyCode: string };
  status?: string;
}

interface LinkedInImageUploadInit {
  value?: {
    uploadUrl?: string;
    uploadUrlExpiresAt?: number;
    image?: string;
  };
}

interface LinkedInVideoUploadInit {
  value?: {
    uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
    video?: string;
    uploadToken?: string;
  };
}

interface LinkedInMediaAsset {
  id?: string;
  status?: string;
  downloadUrl?: string;
}

interface LinkedInAnalyticsElement {
  impressions?: number;
  clicks?: number;
  landingPageClicks?: number;
  costInLocalCurrency?: string | number;
  externalWebsiteConversions?: number;
  oneClickLeads?: number;
}

interface LinkedInRequestResult<T> {
  body: T;
  restliId?: string;
}

/**
 * Performs a Rest.li 2.0.0 request against the versioned LinkedIn API.
 * `rawQuery` is appended verbatim because Rest.li structured query syntax
 * (`q=search&search=(status:(values:List(ACTIVE)))`) must keep its parens,
 * colons, and commas unencoded while URN values inside List() stay encoded.
 */
async function linkedinRequest<T>(
  endpoint: string,
  credentials: AdAccountCredentials,
  options: RequestInit & { rawQuery?: string } = {},
): Promise<LinkedInRequestResult<T>> {
  const url = `${LINKEDIN_API_BASE_URL}${endpoint}${options.rawQuery ? `?${options.rawQuery}` : ""}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "LinkedIn-Version": linkedinVersion(),
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  let body: T | LinkedInErrorBody = {} as T;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = {} as T;
    }
  }
  if (!response.ok) {
    const error = body as LinkedInErrorBody;
    throw new Error(error.message || `LinkedIn API error: ${response.status}`);
  }
  return {
    body: body as T,
    restliId:
      response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id") ?? undefined,
  };
}

function sponsoredAccountUrn(accountId: string): string {
  return `urn:li:sponsoredAccount:${accountId}`;
}

function encodeUrn(urn: string): string {
  return urn.replaceAll(":", "%3A");
}

function moneyAmount(amount: number): string {
  return amount.toFixed(2);
}

function mapObjectiveToLinkedIn(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "BRAND_AWARENESS",
    traffic: "WEBSITE_VISIT",
    engagement: "ENGAGEMENT",
    leads: "LEAD_GENERATION",
    // LinkedIn has no app-install objective; route app promotion to site visits.
    app_promotion: "WEBSITE_VISIT",
    sales: "WEBSITE_CONVERSION",
    conversions: "WEBSITE_CONVERSION",
  };
  return mapping[objective] || "WEBSITE_VISIT";
}

// Auto-bidding target per objective, per the allowable-combinations table:
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ad-budget-pricing-type-combinations
const AUTO_BID_BY_OBJECTIVE: Record<string, string> = {
  BRAND_AWARENESS: "MAX_IMPRESSION",
  WEBSITE_VISIT: "MAX_CLICK",
  ENGAGEMENT: "MAX_CLICK",
  LEAD_GENERATION: "MAX_LEAD",
  WEBSITE_CONVERSION: "MAX_CONVERSION",
  JOB_APPLICANT: "MAX_CLICK",
  VIDEO_VIEW: "MAX_VIDEO_VIEW",
};

/**
 * Maps the platform-neutral campaign bid controls (#11621) onto LinkedIn's
 * costType / optimizationTargetType pair. Auto-bidding targets are always used
 * so campaigns never require a manual unitCost:
 *   - bidStrategy cpm/cpc selects how LinkedIn charges (costType CPM/CPC)
 *   - bidStrategy cpa has no LinkedIn cost type; it maps to conversion
 *     optimization (MAX_CONVERSION) charged by impressions (CPM)
 *   - optimizationGoal reach/clicks/conversions overrides the optimization
 *     target (MAX_IMPRESSION/MAX_CLICK/MAX_CONVERSION)
 */
export function mapBidControlsToLinkedInCampaign(
  input: Pick<CreateCampaignInput, "bidStrategy" | "optimizationGoal" | "objective">,
): { costType: string; optimizationTargetType: string } {
  const objectiveType = mapObjectiveToLinkedIn(input.objective);
  let costType: string;
  if (input.bidStrategy === "cpm" || input.bidStrategy === "cpa") {
    costType = "CPM";
  } else if (input.bidStrategy === "cpc") {
    costType = "CPC";
  } else {
    costType = objectiveType === "BRAND_AWARENESS" ? "CPM" : "CPC";
  }

  let optimizationTargetType: string;
  if (input.optimizationGoal === "reach") {
    optimizationTargetType = "MAX_IMPRESSION";
  } else if (input.optimizationGoal === "clicks") {
    optimizationTargetType = "MAX_CLICK";
  } else if (input.optimizationGoal === "conversions") {
    optimizationTargetType = "MAX_CONVERSION";
  } else if (input.bidStrategy === "cpa") {
    optimizationTargetType = "MAX_CONVERSION";
  } else {
    optimizationTargetType = AUTO_BID_BY_OBJECTIVE[objectiveType] ?? "MAX_CLICK";
  }
  return { costType, optimizationTargetType };
}

function mapCtaToLinkedIn(cta?: string): string {
  const mapping: Record<string, string> = {
    learn_more: "LEARN_MORE",
    shop_now: "VIEW_NOW",
    sign_up: "SIGN_UP",
    download: "DOWNLOAD",
    contact_us: "REQUEST_DEMO",
    get_offer: "UNLOCK_FULL_DOCUMENT",
    book_now: "REGISTER",
    watch_more: "VIEW_NOW",
    apply_now: "APPLY",
    subscribe: "SUBSCRIBE",
  };
  return mapping[cta || "learn_more"] || "LEARN_MORE";
}

/**
 * LinkedIn campaigns must target at least one location. Location entries pass
 * through as urn:li:geo URNs (numeric ids are wrapped); anything else fails
 * loudly instead of guessing a geo mapping. No targeting means Worldwide.
 */
function buildTargetingCriteria(input: CreateCampaignInput): Record<string, unknown> {
  const locations = (input.targeting?.locations ?? []).map((location) => {
    const trimmed = location.trim();
    if (trimmed.startsWith("urn:li:geo:")) return trimmed;
    if (/^\d+$/.test(trimmed)) return `urn:li:geo:${trimmed}`;
    throw new Error(
      `LinkedIn location targeting requires urn:li:geo URNs or numeric geo ids; got "${location}"`,
    );
  });
  return {
    include: {
      and: [
        {
          or: {
            "urn:li:adTargetingFacet:locations": locations.length
              ? locations
              : [LINKEDIN_WORLDWIDE_GEO],
          },
        },
      ],
    },
  };
}

function splitExternalCampaignId(externalCampaignId: string): {
  accountId: string;
  campaignGroupId: string;
  campaignId: string;
} {
  const [accountId, campaignGroupId, campaignId] = externalCampaignId.split("/");
  if (!accountId || !campaignGroupId || !campaignId) {
    throw new Error(
      "LinkedIn campaign operations require a composite accountId/campaignGroupId/campaignId id",
    );
  }
  return { accountId, campaignGroupId, campaignId };
}

async function partialUpdate(
  endpoint: string,
  credentials: AdAccountCredentials,
  set: Record<string, unknown>,
): Promise<void> {
  await linkedinRequest(endpoint, credentials, {
    method: "POST",
    headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
    body: JSON.stringify({ patch: { $set: set } }),
  });
}

async function setCampaignStatus(
  credentials: AdAccountCredentials,
  externalCampaignId: string,
  status: "ACTIVE" | "PAUSED" | "PENDING_DELETION",
): Promise<void> {
  const { accountId, campaignId } = splitExternalCampaignId(externalCampaignId);
  await partialUpdate(
    `/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
    credentials,
    { status },
  );
}

async function getAdAccount(
  credentials: AdAccountCredentials,
  accountId: string,
): Promise<LinkedInAdAccount> {
  const { body } = await linkedinRequest<LinkedInAdAccount>(
    `/adAccounts/${encodeURIComponent(accountId)}`,
    credentials,
  );
  return body;
}

/**
 * Resolves the organization URN that posts/media are attributed to: the
 * explicit page override if given, else the ad account's `reference`.
 */
async function resolveOrganizationUrn(
  credentials: AdAccountCredentials,
  accountId: string,
  pageId?: string,
): Promise<string> {
  if (pageId) {
    return pageId.startsWith("urn:") ? pageId : `urn:li:organization:${pageId}`;
  }
  const account = await getAdAccount(credentials, accountId);
  if (!account.reference) {
    throw new Error(
      "LinkedIn ad account has no organization reference; set one in Campaign Manager or pass pageId",
    );
  }
  return account.reference;
}

function analyticsDate(date: Date): string {
  return `(year:${date.getUTCFullYear()},month:${date.getUTCMonth() + 1},day:${date.getUTCDate()})`;
}

function sumAnalytics(elements: LinkedInAnalyticsElement[]): CampaignMetrics {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  for (const element of elements) {
    spend += Number(element.costInLocalCurrency ?? 0) || 0;
    impressions += element.impressions ?? 0;
    clicks += element.clicks ?? element.landingPageClicks ?? 0;
    conversions += (element.externalWebsiteConversions ?? 0) + (element.oneClickLeads ?? 0);
  }
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

export const linkedinAdsProvider: AdProvider = {
  platform: "linkedin",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    let accounts: Array<{ id: string; name: string }>;
    try {
      accounts = await this.listAdAccounts(credentials);
    } catch (error) {
      // error-policy:J1 boundary — surface the account-discovery transport/auth
      // failure verbatim so a failed fetch stays distinct from a valid account
      // that simply has zero ad accounts (the empty-list branch below).
      logger.error("[LinkedInAds] Validation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        error: error instanceof Error ? error.message : "LinkedIn credential validation failed",
      };
    }
    if (accounts.length === 0) {
      return { valid: false, error: "No LinkedIn ad accounts found or invalid credentials" };
    }
    return { valid: true, accountId: accounts[0].id, accountName: accounts[0].name };
  },

  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }> {
    const clientId = process.env.LINKEDIN_ADS_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_ADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("LinkedIn Ads client credentials are not configured");
    }
    const response = await fetch(LINKEDIN_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error_description?: string;
    };
    if (!response.ok || !json.access_token) {
      throw new Error(json.error_description || "Failed to refresh LinkedIn token");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
    };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const { body } = await linkedinRequest<LinkedInCollection<LinkedInAdAccount>>(
      "/adAccounts",
      credentials,
      { rawQuery: "q=search&search=(status:(values:List(ACTIVE)))&pageSize=1000" },
    );
    return (body.elements ?? []).map((account) => ({
      id: String(account.id),
      name: account.name || String(account.id),
    }));
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      const accountUrn = sponsoredAccountUrn(accountId);
      const currency = input.budgetCurrency || "USD";
      const start = (input.startDate ?? new Date()).getTime();
      const end = input.endDate?.getTime();
      if (input.budgetType === "lifetime" && end === undefined) {
        throw new Error("LinkedIn lifetime (total) budgets require an end date");
      }
      // Validate everything that can fail BEFORE creating the campaign group,
      // so invalid input never leaves an orphan group on the platform.
      const targetingCriteria = buildTargetingCriteria(input);
      const { costType, optimizationTargetType } = mapBidControlsToLinkedInCampaign(input);

      const groupResult = await linkedinRequest<Record<string, never>>(
        `/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups`,
        credentials,
        {
          method: "POST",
          body: JSON.stringify({
            account: accountUrn,
            name: `${input.name} Group`,
            runSchedule: { start, ...(end !== undefined ? { end } : {}) },
            status: "ACTIVE",
            ...(input.budgetType === "lifetime"
              ? { totalBudget: { amount: moneyAmount(input.budgetAmount), currencyCode: currency } }
              : {}),
          }),
        },
      );
      const campaignGroupId = groupResult.restliId;
      if (!campaignGroupId) throw new Error("LinkedIn campaign group create returned no id");

      const budget =
        input.budgetType === "lifetime"
          ? { totalBudget: { amount: moneyAmount(input.budgetAmount), currencyCode: currency } }
          : { dailyBudget: { amount: moneyAmount(input.budgetAmount), currencyCode: currency } };

      const campaignResult = await linkedinRequest<Record<string, never>>(
        `/adAccounts/${encodeURIComponent(accountId)}/adCampaigns`,
        credentials,
        {
          method: "POST",
          body: JSON.stringify({
            account: accountUrn,
            campaignGroup: `urn:li:sponsoredCampaignGroup:${campaignGroupId}`,
            name: input.name,
            type: "SPONSORED_UPDATES",
            objectiveType: mapObjectiveToLinkedIn(input.objective),
            costType,
            optimizationTargetType,
            creativeSelection: "OPTIMIZED",
            audienceExpansionEnabled: false,
            offsiteDeliveryEnabled: false,
            locale: { country: "US", language: "en" },
            runSchedule: { start, ...(end !== undefined ? { end } : {}) },
            targetingCriteria,
            status: "PAUSED",
            ...budget,
          }),
        },
      );
      const campaignId = campaignResult.restliId;
      if (!campaignId) throw new Error("LinkedIn campaign create returned no id");

      return {
        success: true,
        externalCampaignId: `${accountId}/${campaignGroupId}/${campaignId}`,
      };
    } catch (error) {
      logger.error("[LinkedInAds] Campaign creation failed", {
        accountId,
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
      const { accountId, campaignId } = splitExternalCampaignId(externalCampaignId);
      const set: Record<string, unknown> = {};
      if (input.name) set.name = input.name;
      if (input.startDate || input.endDate) {
        set.runSchedule = {
          ...(input.startDate ? { start: input.startDate.getTime() } : {}),
          ...(input.endDate ? { end: input.endDate.getTime() } : {}),
        };
      }
      if (input.budgetAmount !== undefined) {
        // Patch whichever budget field the live campaign actually uses.
        const { body: campaign } = await linkedinRequest<LinkedInCampaign>(
          `/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
          credentials,
        );
        const budgetField =
          campaign.totalBudget && !campaign.dailyBudget ? "totalBudget" : "dailyBudget";
        const currencyCode =
          campaign.dailyBudget?.currencyCode ?? campaign.totalBudget?.currencyCode ?? "USD";
        set[budgetField] = { amount: moneyAmount(input.budgetAmount), currencyCode };
      }
      if (Object.keys(set).length > 0) {
        await partialUpdate(
          `/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
          credentials,
          set,
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
    try {
      await setCampaignStatus(credentials, externalCampaignId, "PAUSED");
      return { success: true, externalCampaignId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    try {
      await setCampaignStatus(credentials, externalCampaignId, "ACTIVE");
      return { success: true, externalCampaignId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { accountId, campaignGroupId } = splitExternalCampaignId(externalCampaignId);
      // Non-DRAFT entities are deleted by moving them to PENDING_DELETION.
      await setCampaignStatus(credentials, externalCampaignId, "PENDING_DELETION");
      await partialUpdate(
        `/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(campaignGroupId)}`,
        credentials,
        { status: "PENDING_DELETION" },
      );
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
      const { campaignId } = splitExternalCampaignId(externalCampaignId);
      const primaryMedia = [...input.media].sort((left, right) => left.order - right.order)[0];
      if (!primaryMedia?.providerAssetId) {
        return {
          success: false,
          error:
            "LinkedIn creatives require media.providerAssetId from a prior LinkedIn media upload",
        };
      }
      const author = await resolveOrganizationUrn(credentials, accountId, input.pageId);

      const result = await linkedinRequest<Record<string, never>>(
        `/adAccounts/${encodeURIComponent(accountId)}/creatives`,
        credentials,
        {
          rawQuery: "action=createInline",
          method: "POST",
          body: JSON.stringify({
            creative: {
              inlineContent: {
                post: {
                  adContext: {
                    dscAdAccount: sponsoredAccountUrn(accountId),
                    dscStatus: "ACTIVE",
                  },
                  author,
                  commentary:
                    input.primaryText || input.description || input.headline || input.name,
                  visibility: "PUBLIC",
                  lifecycleState: "PUBLISHED",
                  isReshareDisabledByAuthor: true,
                  ...(input.destinationUrl
                    ? {
                        contentCallToActionLabel: mapCtaToLinkedIn(input.callToAction),
                        contentLandingPage: input.destinationUrl,
                      }
                    : {}),
                  content: {
                    media: {
                      ...(input.headline ? { title: input.headline } : {}),
                      id: primaryMedia.providerAssetId,
                    },
                  },
                },
              },
              campaign: `urn:li:sponsoredCampaign:${campaignId}`,
              intendedStatus: "ACTIVE",
              name: input.name,
            },
          }),
        },
      );
      if (!result.restliId) throw new Error("LinkedIn creative create returned no id");
      return { success: true, externalCreativeId: result.restliId };
    } catch (error) {
      logger.error("[LinkedInAds] Creative creation failed", {
        accountId,
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
      const owner = await resolveOrganizationUrn(credentials, accountId);
      const media = await downloadAdMedia(input.url, {
        fileName: mediaFileName({ name: input.name, url: input.url, contentType: input.mimeType }),
      });
      const bytes = media.bytes.slice().buffer as ArrayBuffer;

      if (input.type === "image") {
        const init = await linkedinRequest<LinkedInImageUploadInit>("/images", credentials, {
          rawQuery: "action=initializeUpload",
          method: "POST",
          body: JSON.stringify({ initializeUploadRequest: { owner } }),
        });
        const uploadUrl = init.body.value?.uploadUrl;
        const imageUrn = init.body.value?.image;
        if (!uploadUrl || !imageUrn) {
          throw new Error("LinkedIn image upload initialization returned no upload URL");
        }
        const upload = await fetch(uploadUrl, {
          method: "PUT",
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
          body: bytes,
        });
        if (!upload.ok) throw new Error(`LinkedIn image upload failed: ${upload.status}`);
        return {
          success: true,
          providerAssetId: imageUrn,
          providerAssetUrl: input.url,
          providerAssetResourceName: imageUrn,
          metadata: { fileName: media.fileName },
        };
      }

      const init = await linkedinRequest<LinkedInVideoUploadInit>("/videos", credentials, {
        rawQuery: "action=initializeUpload",
        method: "POST",
        body: JSON.stringify({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: bytes.byteLength,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      });
      const videoUrn = init.body.value?.video;
      const uploadToken = init.body.value?.uploadToken ?? "";
      const instructions = init.body.value?.uploadInstructions ?? [];
      if (!videoUrn || instructions.length === 0) {
        throw new Error("LinkedIn video upload initialization returned no upload instructions");
      }
      const uploadedPartIds: string[] = [];
      for (const instruction of instructions) {
        const part = await fetch(instruction.uploadUrl, {
          method: "PUT",
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
          body: bytes.slice(instruction.firstByte, instruction.lastByte + 1),
        });
        if (!part.ok) throw new Error(`LinkedIn video part upload failed: ${part.status}`);
        const etag = part.headers.get("etag");
        if (!etag) throw new Error("LinkedIn video part upload returned no ETag");
        uploadedPartIds.push(etag);
      }
      await linkedinRequest("/videos", credentials, {
        rawQuery: "action=finalizeUpload",
        method: "POST",
        body: JSON.stringify({
          finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds },
        }),
      });
      return {
        success: true,
        providerAssetId: videoUrn,
        providerAssetUrl: input.url,
        providerAssetResourceName: videoUrn,
        metadata: { fileName: media.fileName, parts: uploadedPartIds.length },
      };
    } catch (error) {
      logger.error("[LinkedInAds] Media upload failed", {
        accountId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getMediaStatus(
    credentials: AdAccountCredentials,
    _accountId: string,
    input: { providerAssetResourceName: string },
  ): Promise<AdProviderMediaStatusResult> {
    try {
      const urn = input.providerAssetResourceName;
      const endpoint = urn.startsWith("urn:li:video:") ? "/videos" : "/images";
      const { body } = await linkedinRequest<LinkedInMediaAsset>(
        `${endpoint}/${encodeUrn(urn)}`,
        credentials,
      );
      const status = body.status ?? "UNKNOWN";
      return {
        success: true,
        providerAssetId: urn,
        providerAssetUrl: body.downloadUrl,
        providerAssetResourceName: urn,
        status,
        ready: status === "AVAILABLE",
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    try {
      const { campaignId } = splitExternalCampaignId(externalCampaignId);
      const end = dateRange?.end ?? new Date();
      const start = dateRange?.start ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const campaignUrn = encodeUrn(`urn:li:sponsoredCampaign:${campaignId}`);
      const rawQuery = [
        "q=analytics",
        "pivot=CAMPAIGN",
        "timeGranularity=ALL",
        `dateRange=(start:${analyticsDate(start)},end:${analyticsDate(end)})`,
        `campaigns=List(${campaignUrn})`,
        "fields=impressions,clicks,landingPageClicks,costInLocalCurrency,externalWebsiteConversions,oneClickLeads,pivotValues",
      ].join("&");
      const { body } = await linkedinRequest<LinkedInCollection<LinkedInAnalyticsElement>>(
        "/adAnalytics",
        credentials,
        { rawQuery },
      );
      return { success: true, metrics: sumAnalytics(body.elements ?? []) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
