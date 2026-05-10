// Google Ads API integration - https://developers.google.com/google-ads/api

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

const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

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

async function googleAdsRequest<T>(
  endpoint: string,
  accessToken: string,
  customerId: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${GOOGLE_ADS_BASE_URL}/customers/${customerId}${endpoint}`;

  const response = await fetch(url, {
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
    const response = await fetch(`${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      },
    });

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
    const response = await fetch("https://oauth2.googleapis.com/token", {
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
    const response = await fetch(`${GOOGLE_ADS_BASE_URL}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
      },
    });

    if (!response.ok) {
      throw new Error("Failed to list Google Ads accounts");
    }

    const data = (await response.json()) as { resourceNames: string[] };

    // Get details for each customer
    const accounts: Array<{ id: string; name: string }> = [];

    for (const resourceName of data.resourceNames || []) {
      const customerId = resourceName.replace("customers/", "");

      const customerResponse = await googleAdsRequest<{
        results: Array<{ customer: GoogleAdsCustomer }>;
      }>("/googleAds:searchStream", credentials.accessToken, customerId, {
        method: "POST",
        body: JSON.stringify({
          query: `SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1`,
        }),
      }).catch((err) => {
        logger.warn("[GoogleAds] Failed to fetch customer details", {
          customerId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

      if (customerResponse?.results?.[0]) {
        const customer = customerResponse.results[0].customer;
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
              type: "SEARCH_STANDARD",
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

    // Create responsive search ad
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
              ad: {
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
              },
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
