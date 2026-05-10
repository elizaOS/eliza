import {
  type AdAccount,
  type AdCampaign,
  type AdCreative,
  adAccountsRepository,
  adCampaignsRepository,
  adCreativesRepository,
  adTransactionsRepository,
} from "@/db/repositories";
import { creditsService } from "@/lib/services/credits";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import { googleAdsProvider } from "./providers/google";
import { metaAdsProvider } from "./providers/meta";
import { tiktokAdsProvider } from "./providers/tiktok";
import type {
  AdAccountCredentials,
  AdPlatform,
  AdProvider,
  CampaignMetrics,
  ConnectAccountInput,
  CreateCampaignInput,
  CreateCreativeInput,
  UpdateCampaignInput,
  UpdateCreativeInput,
} from "./types";
import { AD_CREDIT_RATES, calculateSpendCredits } from "./types";

export * from "./schemas";
export * from "./types";

// Provider registry
const providers: Record<AdPlatform, AdProvider | null> = {
  meta: metaAdsProvider,
  google: googleAdsProvider,
  tiktok: tiktokAdsProvider,
};

class AdvertisingService {
  getSupportedPlatforms(): AdPlatform[] {
    return Object.entries(providers)
      .filter(([_, p]) => p !== null)
      .map(([platform]) => platform as AdPlatform);
  }

  getProvider(platform: AdPlatform): AdProvider {
    const provider = providers[platform];
    if (!provider) {
      throw new Error(`Advertising platform ${platform} is not supported`);
    }
    return provider;
  }

  // ============================================
  // Credential Management
  // ============================================

  private async getCredentials(account: AdAccount): Promise<AdAccountCredentials> {
    const [accessToken, refreshToken] = await Promise.all([
      account.access_token_secret_id
        ? secretsService.getDecryptedValue(account.access_token_secret_id, account.organization_id)
        : undefined,
      account.refresh_token_secret_id
        ? secretsService.getDecryptedValue(account.refresh_token_secret_id, account.organization_id)
        : undefined,
    ]);

    if (!accessToken) {
      throw new Error("No access token found for ad account");
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: account.token_expires_at ?? undefined,
    };
  }

  // ============================================
  // Ad Account Operations
  // ============================================

  async listAccounts(
    organizationId: string,
    options?: { platform?: AdPlatform },
  ): Promise<AdAccount[]> {
    return await adAccountsRepository.listByOrganization(organizationId, options);
  }

  async getAccount(id: string): Promise<AdAccount | undefined> {
    return await adAccountsRepository.findById(id);
  }

  async connectAccount(input: ConnectAccountInput): Promise<AdAccount> {
    logger.info("[Advertising] Connecting ad account", {
      organizationId: input.organizationId,
      platform: input.platform,
    });

    const provider = this.getProvider(input.platform);

    // Validate credentials
    if (!input.accessToken) {
      throw new Error("Access token is required");
    }

    const validation = await provider.validateCredentials({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
    });

    if (!validation.valid) {
      throw new Error(validation.error || "Invalid credentials");
    }

    // Store access token securely
    const accessTokenSecret = await secretsService.create(
      {
        organizationId: input.organizationId,
        name: `${input.platform.toUpperCase()}_AD_ACCESS_TOKEN`,
        value: input.accessToken,
        scope: "organization",
        createdBy: input.userId,
      },
      {
        actorType: "user",
        actorId: input.userId,
        source: "advertising-service",
      },
    );

    // Store refresh token if provided
    let refreshTokenSecretId: string | undefined;
    if (input.refreshToken) {
      const refreshTokenSecret = await secretsService.create(
        {
          organizationId: input.organizationId,
          name: `${input.platform.toUpperCase()}_AD_REFRESH_TOKEN`,
          value: input.refreshToken,
          scope: "organization",
          createdBy: input.userId,
        },
        {
          actorType: "user",
          actorId: input.userId,
          source: "advertising-service",
        },
      );
      refreshTokenSecretId = refreshTokenSecret.id;
    }

    // Create account record
    const account = await adAccountsRepository.create({
      organization_id: input.organizationId,
      connected_by_user_id: input.userId,
      platform: input.platform,
      external_account_id: input.externalAccountId || validation.accountId || "",
      account_name: input.accountName || validation.accountName || "Ad Account",
      access_token_secret_id: accessTokenSecret.id,
      refresh_token_secret_id: refreshTokenSecretId,
      status: "active",
    });

    logger.info("[Advertising] Ad account connected", {
      accountId: account.id,
      platform: input.platform,
    });

    return account;
  }

  async disconnectAccount(accountId: string, organizationId: string): Promise<void> {
    const account = await adAccountsRepository.findById(accountId);

    if (!account || account.organization_id !== organizationId) {
      throw new Error("Ad account not found");
    }

    const audit = {
      actorType: "system" as const,
      actorId: account.connected_by_user_id ?? "advertising-service",
      source: "advertising-service",
    };
    // Delete secrets - log but don't fail if already deleted
    if (account.access_token_secret_id) {
      await secretsService
        .delete(account.access_token_secret_id, organizationId, audit)
        .catch((e) =>
          logger.warn("[Advertising] Failed to delete access token secret", {
            error: e,
          }),
        );
    }
    if (account.refresh_token_secret_id) {
      await secretsService
        .delete(account.refresh_token_secret_id, organizationId, audit)
        .catch((e) =>
          logger.warn("[Advertising] Failed to delete refresh token secret", {
            error: e,
          }),
        );
    }

    await adAccountsRepository.delete(accountId);

    logger.info("[Advertising] Ad account disconnected", { accountId });
  }

  async listAvailableAdAccounts(
    organizationId: string,
    platform: AdPlatform,
    accessToken: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const provider = this.getProvider(platform);
    return await provider.listAdAccounts({ accessToken });
  }

  // ============================================
  // Campaign Operations
  // ============================================

  async listCampaigns(
    organizationId: string,
    options?: {
      adAccountId?: string;
      platform?: AdPlatform;
      status?: string;
      appId?: string;
    },
  ): Promise<AdCampaign[]> {
    return await adCampaignsRepository.listByOrganization(
      organizationId,
      options as Parameters<typeof adCampaignsRepository.listByOrganization>[1],
    );
  }

  async getCampaign(id: string): Promise<AdCampaign | undefined> {
    return await adCampaignsRepository.findById(id);
  }

  async createCampaign(input: CreateCampaignInput): Promise<AdCampaign> {
    logger.info("[Advertising] Creating campaign", {
      organizationId: input.organizationId,
      name: input.name,
    });

    const account = await adAccountsRepository.findById(input.adAccountId);
    if (!account || account.organization_id !== input.organizationId) {
      throw new Error("Ad account not found");
    }

    // Charge credits for campaign creation
    const deduction = await creditsService.deductCredits({
      organizationId: input.organizationId,
      amount: AD_CREDIT_RATES.createCampaign,
      description: `Create ad campaign: ${input.name}`,
      metadata: { platform: account.platform, campaignName: input.name },
    });

    if (!deduction.success) {
      throw new Error("Insufficient credits to create campaign");
    }

    // Allocate budget credits
    const budgetCredits = calculateSpendCredits(account.platform, input.budgetAmount);

    const budgetDeduction = await creditsService.deductCredits({
      organizationId: input.organizationId,
      amount: budgetCredits,
      description: `Budget allocation for campaign: ${input.name}`,
      metadata: {
        platform: account.platform,
        budgetAmount: input.budgetAmount,
        markup: budgetCredits - input.budgetAmount,
      },
    });

    if (!budgetDeduction.success) {
      // Refund campaign creation credits
      await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: AD_CREDIT_RATES.createCampaign,
        description: "Refund: Campaign creation failed due to insufficient budget",
        metadata: {},
      });
      throw new Error("Insufficient credits for campaign budget");
    }
    if (!budgetDeduction.transaction) {
      throw new Error("Failed to record budget deduction transaction");
    }

    // Create campaign on the platform
    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.createCampaign(credentials, account.external_account_id, input);

    if (!result.success) {
      // Refund all credits
      await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: 0.5 + budgetCredits,
        description: `Refund: Campaign creation failed - ${result.error}`,
        metadata: {},
      });
      throw new Error(result.error || "Failed to create campaign on platform");
    }

    // Create campaign record
    const campaign = await adCampaignsRepository.create({
      organization_id: input.organizationId,
      ad_account_id: input.adAccountId,
      external_campaign_id: result.externalCampaignId,
      name: input.name,
      platform: account.platform,
      objective: input.objective,
      status: "pending",
      budget_type: input.budgetType,
      budget_amount: String(input.budgetAmount),
      budget_currency: input.budgetCurrency || "USD",
      credits_allocated: String(budgetCredits),
      start_date: input.startDate,
      end_date: input.endDate,
      targeting: input.targeting || {},
      app_id: input.appId,
    });

    // Record budget allocation transaction
    await adTransactionsRepository.create({
      organization_id: input.organizationId,
      campaign_id: campaign.id,
      credit_transaction_id: budgetDeduction.transaction.id,
      type: "budget_allocation",
      amount: String(input.budgetAmount),
      currency: input.budgetCurrency || "USD",
      credits_amount: String(budgetCredits),
      description: `Budget allocated for campaign: ${input.name}`,
    });

    logger.info("[Advertising] Campaign created", {
      campaignId: campaign.id,
      externalId: result.externalCampaignId,
    });

    return campaign;
  }

  async updateCampaign(
    campaignId: string,
    organizationId: string,
    input: UpdateCampaignInput,
  ): Promise<AdCampaign> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    if (!campaign.external_campaign_id) {
      throw new Error("Campaign not synced with platform");
    }

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.updateCampaign(credentials, campaign.external_campaign_id, input);

    if (!result.success) {
      throw new Error(result.error || "Failed to update campaign");
    }

    const updated = await adCampaignsRepository.update(campaignId, {
      name: input.name,
      budget_amount: input.budgetAmount ? String(input.budgetAmount) : undefined,
      start_date: input.startDate,
      end_date: input.endDate,
      targeting: input.targeting,
    });

    logger.info("[Advertising] Campaign updated", { campaignId });

    return updated!;
  }

  async startCampaign(campaignId: string, organizationId: string): Promise<AdCampaign> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    if (!campaign.external_campaign_id) {
      throw new Error("Campaign not synced with platform");
    }

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.activateCampaign(credentials, campaign.external_campaign_id);

    if (!result.success) {
      throw new Error(result.error || "Failed to start campaign");
    }

    const updated = await adCampaignsRepository.updateStatus(campaignId, "active");

    logger.info("[Advertising] Campaign started", { campaignId });

    return updated!;
  }

  async pauseCampaign(campaignId: string, organizationId: string): Promise<AdCampaign> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    if (!campaign.external_campaign_id) {
      throw new Error("Campaign not synced with platform");
    }

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.pauseCampaign(credentials, campaign.external_campaign_id);

    if (!result.success) {
      throw new Error(result.error || "Failed to pause campaign");
    }

    const updated = await adCampaignsRepository.updateStatus(campaignId, "paused");

    logger.info("[Advertising] Campaign paused", { campaignId });

    return updated!;
  }

  async deleteCampaign(campaignId: string, organizationId: string): Promise<void> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    // If synced with platform, delete there first
    if (campaign.external_campaign_id) {
      const account = await adAccountsRepository.findById(campaign.ad_account_id);
      if (account) {
        const credentials = await this.getCredentials(account);
        const provider = this.getProvider(account.platform);
        await provider.deleteCampaign(credentials, campaign.external_campaign_id);
      }
    }

    // Refund unused budget
    const creditsAllocated = parseFloat(campaign.credits_allocated);
    const creditsSpent = parseFloat(campaign.credits_spent);
    const creditsRemaining = creditsAllocated - creditsSpent;

    if (creditsRemaining > 0) {
      await creditsService.refundCredits({
        organizationId,
        amount: creditsRemaining,
        description: `Refund unused budget for deleted campaign: ${campaign.name}`,
        metadata: { campaignId, campaignName: campaign.name },
      });

      await adTransactionsRepository.create({
        organization_id: organizationId,
        campaign_id: campaignId,
        type: "refund",
        amount: String(creditsRemaining),
        currency: campaign.budget_currency,
        credits_amount: String(creditsRemaining),
        description: `Refund for deleted campaign: ${campaign.name}`,
      });
    }

    await adCampaignsRepository.delete(campaignId);

    logger.info("[Advertising] Campaign deleted", { campaignId });
  }

  async getCampaignMetrics(
    campaignId: string,
    organizationId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<CampaignMetrics> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    if (!campaign.external_campaign_id) {
      // Return stored metrics if not synced
      return {
        spend: parseFloat(campaign.total_spend),
        impressions: campaign.total_impressions,
        clicks: campaign.total_clicks,
        conversions: campaign.total_conversions,
      };
    }

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.getCampaignMetrics(
      credentials,
      campaign.external_campaign_id,
      dateRange,
    );

    if (!result.success || !result.metrics) {
      throw new Error(result.error || "Failed to get metrics");
    }

    // Update stored metrics
    await adCampaignsRepository.updateMetrics(campaignId, {
      totalSpend: String(result.metrics.spend),
      totalImpressions: result.metrics.impressions,
      totalClicks: result.metrics.clicks,
      totalConversions: result.metrics.conversions,
    });

    return result.metrics;
  }

  // ============================================
  // Creative Operations
  // ============================================

  async listCreatives(campaignId: string, organizationId: string): Promise<AdCreative[]> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    return await adCreativesRepository.listByCampaign(campaignId);
  }

  async createCreative(organizationId: string, input: CreateCreativeInput): Promise<AdCreative> {
    const campaign = await adCampaignsRepository.findById(input.campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    // Charge credits for creative creation
    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: AD_CREDIT_RATES.createCreative,
      description: `Create ad creative: ${input.name}`,
      metadata: { campaignId: input.campaignId, creativeName: input.name },
    });

    if (!deduction.success) {
      throw new Error("Insufficient credits to create creative");
    }

    // Create creative record
    const creative = await adCreativesRepository.create({
      campaign_id: input.campaignId,
      name: input.name,
      type: input.type,
      headline: input.headline,
      primary_text: input.primaryText,
      description: input.description,
      call_to_action: input.callToAction,
      destination_url: input.destinationUrl,
      media: input.media,
      metadata: {
        facebook_page_id: input.pageId,
        instagram_account_id: input.instagramActorId,
        tiktok_identity_id: input.tiktokIdentityId,
        tiktok_identity_type: input.tiktokIdentityType,
      },
      status: "draft",
    });

    // Sync with platform if campaign is synced
    if (campaign.external_campaign_id) {
      const account = await adAccountsRepository.findById(campaign.ad_account_id);
      if (account) {
        const credentials = await this.getCredentials(account);
        const provider = this.getProvider(account.platform);

        const result = await provider.createCreative(
          credentials,
          account.external_account_id,
          campaign.external_campaign_id,
          input,
        );

        if (result.success && result.externalCreativeId) {
          const updated = await adCreativesRepository.update(creative.id, {
            external_creative_id: result.externalCreativeId,
            status: "pending_review",
          });
          if (updated) {
            logger.info("[Advertising] Creative created", { creativeId: updated.id });
            return updated;
          }
        } else {
          await creditsService.refundCredits({
            organizationId,
            amount: AD_CREDIT_RATES.createCreative,
            description: `Refund: Creative creation failed - ${result.error}`,
            metadata: { campaignId: input.campaignId, creativeName: input.name },
          });
          await adCreativesRepository.update(creative.id, {
            status: "rejected",
            metadata: {
              ...(creative.metadata ?? {}),
              rejection_reason: result.error || "Failed to create creative on platform",
            },
          });
          throw new Error(result.error || "Failed to create creative on platform");
        }
      }
    }

    logger.info("[Advertising] Creative created", { creativeId: creative.id });

    return creative;
  }

  async updateCreative(
    creativeId: string,
    organizationId: string,
    input: UpdateCreativeInput,
  ): Promise<AdCreative> {
    const creative = await adCreativesRepository.findById(creativeId);
    if (!creative) {
      throw new Error("Creative not found");
    }

    const campaign = await adCampaignsRepository.findById(creative.campaign_id);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    const updated = await adCreativesRepository.update(creativeId, {
      name: input.name,
      headline: input.headline,
      primary_text: input.primaryText,
      description: input.description,
      call_to_action: input.callToAction,
      destination_url: input.destinationUrl,
      media: input.media,
    });

    logger.info("[Advertising] Creative updated", { creativeId });

    return updated!;
  }

  async deleteCreative(creativeId: string, organizationId: string): Promise<void> {
    const creative = await adCreativesRepository.findById(creativeId);
    if (!creative) {
      throw new Error("Creative not found");
    }

    const campaign = await adCampaignsRepository.findById(creative.campaign_id);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    await adCreativesRepository.delete(creativeId);

    logger.info("[Advertising] Creative deleted", { creativeId });
  }

  // ============================================
  // Statistics
  // ============================================

  async getStats(
    organizationId: string,
    options?: { platform?: AdPlatform },
  ): Promise<{
    totalCampaigns: number;
    activeCampaigns: number;
    totalSpend: number;
    totalImpressions: number;
    totalClicks: number;
    totalConversions: number;
  }> {
    return await adCampaignsRepository.getStats(organizationId, options);
  }
}

export const advertisingService = new AdvertisingService();
