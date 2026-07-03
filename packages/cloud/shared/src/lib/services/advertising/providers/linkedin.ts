// LinkedIn Marketing API integration - https://learn.microsoft.com/linkedin/marketing

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

const LINKEDIN_ADS_BASE_URL = "https://api.linkedin.com/rest";
const LINKEDIN_VERSION = process.env.LINKEDIN_MARKETING_VERSION || "202606";

interface LinkedInListResponse<T> {
  elements?: T[];
}

interface LinkedInAdAccount {
  id: number | string;
  name?: string;
  status?: string;
}

interface LinkedInCampaignGroup {
  id?: number | string;
  name?: string;
  status?: string;
}

interface LinkedInAnalyticsRow {
  costInLocalCurrency?: string;
  impressions?: number;
  landingPageClicks?: number;
  externalWebsiteConversions?: number;
}

interface LinkedInImageInitializeResponse {
  value?: {
    uploadUrl?: string;
    image?: string;
    uploadUrlExpiresAt?: number;
  };
}

interface LinkedInImageStatusResponse {
  id?: string;
  status?: string;
  downloadUrl?: string;
}

interface LinkedInRequestResult<T> {
  data: T;
  restliId?: string;
}

async function linkedinRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit & { params?: Record<string, string> } = {},
): Promise<LinkedInRequestResult<T>> {
  const url = new URL(
    endpoint.startsWith("http") ? endpoint : `${LINKEDIN_ADS_BASE_URL}${endpoint}`,
  );
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Linkedin-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      ...options.headers,
    },
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    const errorData = data as Record<string, unknown>;
    const message =
      typeof errorData.message === "string"
        ? errorData.message
        : `LinkedIn Marketing API error: ${response.status}`;
    throw new Error(message);
  }

  return {
    data: data as T,
    restliId: response.headers.get("x-restli-id") ?? undefined,
  };
}

function mapObjectiveToLinkedIn(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "BRAND_AWARENESS",
    traffic: "WEBSITE_VISITS",
    engagement: "ENGAGEMENT",
    leads: "LEAD_GENERATION",
    app_promotion: "WEBSITE_VISITS",
    sales: "WEBSITE_CONVERSIONS",
    conversions: "WEBSITE_CONVERSIONS",
  };
  return mapping[objective] || "WEBSITE_VISITS";
}

function campaignUrn(campaignId: string): string {
  return campaignId.startsWith("urn:li:sponsoredCampaign:")
    ? campaignId
    : `urn:li:sponsoredCampaign:${campaignId}`;
}

function campaignGroupUrn(groupId: string): string {
  return groupId.startsWith("urn:li:sponsoredCampaignGroup:")
    ? groupId
    : `urn:li:sponsoredCampaignGroup:${groupId}`;
}

function sponsoredAccountUrn(accountId: string): string {
  return accountId.startsWith("urn:li:sponsoredAccount:")
    ? accountId
    : `urn:li:sponsoredAccount:${accountId}`;
}

function splitLinkedInCampaignId(
  fallbackAccountId: string,
  externalCampaignId: string,
): { accountId: string; campaignGroupId?: string; campaignId: string } {
  const parts = externalCampaignId.split("/");
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { accountId: parts[0], campaignGroupId: parts[1], campaignId: parts[2] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { accountId: parts[0], campaignId: parts[1] };
  }
  return { accountId: fallbackAccountId, campaignId: externalCampaignId };
}

function linkedInDate(date: Date): { year: number; month: number; day: number } {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function linkedInPatch(set: Record<string, unknown>): { patch: { $set: Record<string, unknown> } } {
  return { patch: { $set: set } };
}

function firstLinkedInId(...values: Array<number | string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) {
      return value.startsWith("urn:li:") ? value.split(":").pop() : value.trim();
    }
  }
  return undefined;
}

async function getOrCreateCampaignGroup(
  credentials: AdAccountCredentials,
  accountId: string,
): Promise<string> {
  const existing = await linkedinRequest<LinkedInListResponse<LinkedInCampaignGroup>>(
    `/adAccounts/${accountId}/adCampaignGroups`,
    credentials.accessToken,
    {
      method: "GET",
      params: {
        q: "search",
        search: "(status:(values:List(ACTIVE,DRAFT,PAUSED)))",
        pageSize: "1",
      },
    },
  );
  const existingId = firstLinkedInId(existing.data.elements?.[0]?.id);
  if (existingId) return existingId;

  const created = await linkedinRequest<Record<string, unknown>>(
    `/adAccounts/${accountId}/adCampaignGroups`,
    credentials.accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        name: "elizaOS Campaigns",
        runSchedule: { start: Date.now() },
        status: "PAUSED",
      }),
    },
  );

  const createdId = firstLinkedInId(created.restliId, created.data.id as string | undefined);
  if (!createdId) {
    throw new Error("LinkedIn campaign group creation returned no campaign group id");
  }
  return createdId;
}

function buildLinkedInCampaignPayload(
  accountId: string,
  campaignGroupId: string,
  input: CreateCampaignInput,
): Record<string, unknown> {
  const currencyCode = input.budgetCurrency || "USD";
  const budget = {
    amount: input.budgetAmount.toFixed(2),
    currencyCode,
  };

  return {
    account: sponsoredAccountUrn(accountId),
    campaignGroup: campaignGroupUrn(campaignGroupId),
    creativeSelection: "OPTIMIZED",
    name: input.name,
    objectiveType: mapObjectiveToLinkedIn(input.objective),
    runSchedule: {
      start: (input.startDate ?? new Date()).getTime(),
      ...(input.endDate ? { end: input.endDate.getTime() } : {}),
    },
    status: "PAUSED",
    type: "TEXT_AD",
    ...(input.budgetType === "daily" ? { dailyBudget: budget } : { totalBudget: budget }),
    unitCost: { amount: "1.00", currencyCode },
  };
}

export const linkedinAdsProvider: AdProvider = {
  platform: "linkedin",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    const accounts = await this.listAdAccounts(credentials).catch((error) => {
      logger.error("[LinkedInAds] Validation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });

    const account = accounts[0];
    if (!account) {
      return {
        valid: false,
        error: "No LinkedIn ad accounts found or invalid credentials",
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
    const response = await linkedinRequest<LinkedInListResponse<LinkedInAdAccount>>(
      "/adAccounts",
      credentials.accessToken,
      {
        method: "GET",
        params: { q: "search", pageSize: "1000" },
      },
    );

    return (response.data.elements ?? []).map((account) => {
      const id = String(account.id);
      return {
        id,
        name: account.name || `LinkedIn Ad Account ${id}`,
      };
    });
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      logger.info("[LinkedInAds] Creating campaign", {
        accountId,
        name: input.name,
        objective: input.objective,
      });

      const campaignGroupId = await getOrCreateCampaignGroup(credentials, accountId);
      const response = await linkedinRequest<Record<string, unknown>>(
        `/adAccounts/${accountId}/adCampaigns`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify(buildLinkedInCampaignPayload(accountId, campaignGroupId, input)),
        },
      );

      const campaignId = firstLinkedInId(response.restliId, response.data.id as string | undefined);
      if (!campaignId) {
        return { success: false, error: "LinkedIn campaign creation returned no campaign id" };
      }

      logger.info("[LinkedInAds] Campaign created", {
        accountId,
        campaignGroupId,
        campaignId,
      });

      return {
        success: true,
        externalCampaignId: `${accountId}/${campaignGroupId}/${campaignId}`,
      };
    } catch (error) {
      logger.error("[LinkedInAds] Campaign creation failed", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "LinkedIn campaign creation failed",
      };
    }
  },

  async updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId } = splitLinkedInCampaignId("", externalCampaignId);
    const updateFields: Record<string, unknown> = {};
    if (input.name) updateFields.name = input.name;
    if (input.budgetAmount) {
      updateFields.dailyBudget = {
        amount: input.budgetAmount.toFixed(2),
        currencyCode: "USD",
      };
    }
    if (input.startDate || input.endDate) {
      updateFields.runSchedule = {
        ...(input.startDate ? { start: input.startDate.getTime() } : {}),
        ...(input.endDate ? { end: input.endDate.getTime() } : {}),
      };
    }

    await linkedinRequest(
      `/adAccounts/${accountId}/adCampaigns/${campaignId}`,
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify(linkedInPatch(updateFields)),
      },
    );

    return { success: true, externalCampaignId };
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId } = splitLinkedInCampaignId("", externalCampaignId);
    await linkedinRequest(
      `/adAccounts/${accountId}/adCampaigns/${campaignId}`,
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify(linkedInPatch({ status: "PAUSED" })),
      },
    );
    return { success: true, externalCampaignId };
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    const { accountId, campaignId } = splitLinkedInCampaignId("", externalCampaignId);
    await linkedinRequest(
      `/adAccounts/${accountId}/adCampaigns/${campaignId}`,
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify(linkedInPatch({ status: "ACTIVE" })),
      },
    );
    return { success: true, externalCampaignId };
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { accountId, campaignId } = splitLinkedInCampaignId("", externalCampaignId);
    await linkedinRequest(
      `/adAccounts/${accountId}/adCampaigns/${campaignId}`,
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify(linkedInPatch({ status: "ARCHIVED" })),
      },
    );
    return { success: true };
  },

  async createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult> {
    try {
      const campaign = splitLinkedInCampaignId(accountId, externalCampaignId);
      const response = await linkedinRequest<Record<string, unknown>>(
        `/adAccounts/${campaign.accountId}/creatives`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            campaign: campaignUrn(campaign.campaignId),
            name: input.name,
            status: "PAUSED",
            type: "TEXT_AD",
            variables: {
              clickUri: input.destinationUrl,
              data: {
                "com.linkedin.ads.TextAdCreativeVariables": {
                  title: input.headline || input.name,
                  text: input.primaryText || input.description || input.name,
                },
              },
            },
          }),
        },
      );

      const creativeId = firstLinkedInId(response.restliId, response.data.id as string | undefined);
      if (!creativeId) {
        return { success: false, error: "LinkedIn creative creation returned no creative id" };
      }

      return { success: true, externalCreativeId: creativeId };
    } catch (error) {
      logger.error("[LinkedInAds] Creative creation failed", {
        accountId,
        externalCampaignId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "LinkedIn creative creation failed",
      };
    }
  },

  async uploadMedia(
    credentials: AdAccountCredentials,
    accountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    if (input.type !== "image") {
      return { success: false, error: "LinkedIn media upload currently supports image assets" };
    }

    try {
      const fileName = mediaFileName({
        name: input.name,
        url: input.url,
        contentType: input.mimeType,
        fallbackExtension: "png",
      });
      const media = await downloadAdMedia(input.url, {
        allowedContentTypes: ["image/jpeg", "image/png", "image/gif"],
        fileName,
      });

      const initialize = await linkedinRequest<LinkedInImageInitializeResponse>(
        "/images",
        credentials.accessToken,
        {
          method: "POST",
          params: { action: "initializeUpload" },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: sponsoredAccountUrn(accountId),
              mediaLibraryMetadata: {
                associatedAccount: sponsoredAccountUrn(accountId),
                assetName: fileName,
              },
            },
          }),
        },
      );

      const uploadUrl = initialize.data.value?.uploadUrl;
      const imageUrn = initialize.data.value?.image;
      if (!uploadUrl || !imageUrn) {
        return {
          success: false,
          error: "LinkedIn image upload initialization returned no upload URL",
        };
      }

      const uploadBody = new ArrayBuffer(media.bytes.byteLength);
      new Uint8Array(uploadBody).set(media.bytes);
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": media.contentType,
        },
        body: uploadBody,
      });

      if (!uploadResponse.ok) {
        throw new Error(`LinkedIn image binary upload failed: ${uploadResponse.status}`);
      }

      return {
        success: true,
        providerAssetId: imageUrn,
        providerAssetResourceName: imageUrn,
        providerAssetUrl: media.url,
        metadata: {
          fileName,
          uploadUrlExpiresAt: initialize.data.value?.uploadUrlExpiresAt,
        },
      };
    } catch (error) {
      logger.error("[LinkedInAds] Media upload failed", {
        accountId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "LinkedIn media upload failed",
      };
    }
  },

  async getMediaStatus(
    credentials: AdAccountCredentials,
    _accountId: string,
    input: GetMediaStatusInput,
  ) {
    const response = await linkedinRequest<LinkedInImageStatusResponse>(
      `/images/${encodeURIComponent(input.providerAssetResourceName)}`,
      credentials.accessToken,
      { method: "GET" },
    );
    return {
      success: true,
      providerAssetId: response.data.id ?? input.providerAssetResourceName,
      providerAssetUrl: response.data.downloadUrl,
      providerAssetResourceName: response.data.id ?? input.providerAssetResourceName,
      status: response.data.status,
      ready: response.data.status === "AVAILABLE",
    };
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const { campaignId } = splitLinkedInCampaignId("", externalCampaignId);
    const start = dateRange?.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = dateRange?.end;
    const response = await linkedinRequest<LinkedInListResponse<LinkedInAnalyticsRow>>(
      "/adAnalytics",
      credentials.accessToken,
      {
        method: "GET",
        params: {
          q: "analytics",
          pivot: "CAMPAIGN",
          timeGranularity: "ALL",
          campaigns: `List(${campaignUrn(campaignId)})`,
          dateRange: `(start:(${Object.entries(linkedInDate(start))
            .map(([key, value]) => `${key}:${value}`)
            .join(",")})${
            end
              ? `,end:(${Object.entries(linkedInDate(end))
                  .map(([key, value]) => `${key}:${value}`)
                  .join(",")})`
              : ""
          })`,
          fields:
            "externalWebsiteConversions,dateRange,impressions,landingPageClicks,costInLocalCurrency,pivotValues",
        },
      },
    );

    const totals = (response.data.elements ?? []).reduce<CampaignMetrics>(
      (acc, row) => ({
        spend: acc.spend + Number.parseFloat(row.costInLocalCurrency ?? "0"),
        impressions: acc.impressions + (row.impressions ?? 0),
        clicks: acc.clicks + (row.landingPageClicks ?? 0),
        conversions: acc.conversions + (row.externalWebsiteConversions ?? 0),
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    );

    return { success: true, metrics: totals };
  },
};
