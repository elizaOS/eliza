/**
 * Advertising Platform Types
 *
 * Type definitions for the advertising service and ad platform integrations.
 */

import type { AdAccountStatus, AdPlatform } from "@/db/schemas/ad-accounts";
import type { BudgetType, CampaignObjective, CampaignStatus } from "@/db/schemas/ad-campaigns";
import type { CallToAction, CreativeStatus, CreativeType } from "@/db/schemas/ad-creatives";

export type {
  AdAccountStatus,
  AdPlatform,
  BudgetType,
  CallToAction,
  CampaignObjective,
  CampaignStatus,
  CreativeStatus,
  CreativeType,
};

// ============================================
// Ad Account Types
// ============================================

export interface AdAccountCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface ConnectAccountInput {
  organizationId: string;
  userId: string;
  platform: AdPlatform;
  authCode?: string;
  accessToken?: string;
  refreshToken?: string;
  externalAccountId?: string;
  accountName?: string;
}

export interface ConnectedAccount {
  id: string;
  platform: AdPlatform;
  externalAccountId: string;
  accountName: string;
  status: AdAccountStatus;
}

// ============================================
// Campaign Types
// ============================================

export interface CampaignTargeting {
  locations?: string[];
  ageMin?: number;
  ageMax?: number;
  genders?: ("male" | "female" | "all")[];
  interests?: string[];
  behaviors?: string[];
  customAudiences?: string[];
  excludedAudiences?: string[];
  placements?: string[];
  languages?: string[];
}

export interface CreateCampaignInput {
  organizationId: string;
  adAccountId: string;
  name: string;
  objective: CampaignObjective;
  budgetType: BudgetType;
  budgetAmount: number;
  budgetCurrency?: string;
  startDate?: Date;
  endDate?: Date;
  targeting?: CampaignTargeting;
  appId?: string;
}

export interface UpdateCampaignInput {
  name?: string;
  budgetAmount?: number;
  startDate?: Date;
  endDate?: Date;
  targeting?: CampaignTargeting;
}

export interface CampaignMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  roas?: number;
}

// ============================================
// Creative Types
// ============================================

export interface CreativeMedia {
  id: string;
  source: "generation" | "upload";
  url: string;
  providerAssetId?: string;
  thumbnailUrl?: string;
  type: "image" | "video";
  order: number;
}

export interface CreateCreativeInput {
  campaignId: string;
  name: string;
  type: CreativeType;
  headline?: string;
  primaryText?: string;
  description?: string;
  callToAction?: CallToAction;
  destinationUrl?: string;
  media: CreativeMedia[];
  pageId?: string;
  instagramActorId?: string;
  tiktokIdentityId?: string;
  tiktokIdentityType?: string;
}

export interface UpdateCreativeInput {
  name?: string;
  headline?: string;
  primaryText?: string;
  description?: string;
  callToAction?: CallToAction;
  destinationUrl?: string;
  media?: CreativeMedia[];
}

// ============================================
// Provider Interface
// ============================================

export interface AdProviderValidationResult {
  valid: boolean;
  accountId?: string;
  accountName?: string;
  error?: string;
}

export interface AdProviderCampaignResult {
  success: boolean;
  externalCampaignId?: string;
  error?: string;
}

export interface AdProviderCreativeResult {
  success: boolean;
  externalCreativeId?: string;
  error?: string;
}

export interface AdProviderMetricsResult {
  success: boolean;
  metrics?: CampaignMetrics;
  error?: string;
}

/**
 * Interface for ad platform providers.
 */
export interface AdProvider {
  platform: AdPlatform;

  /**
   * Validates ad account credentials.
   */
  validateCredentials(credentials: AdAccountCredentials): Promise<AdProviderValidationResult>;

  /**
   * Refreshes access token if expired.
   */
  refreshToken?(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;

  /**
   * Lists available ad accounts for the authenticated user.
   */
  listAdAccounts(credentials: AdAccountCredentials): Promise<Array<{ id: string; name: string }>>;

  /**
   * Creates a campaign on the ad platform.
   */
  createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult>;

  /**
   * Updates a campaign on the ad platform.
   */
  updateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    input: UpdateCampaignInput,
  ): Promise<AdProviderCampaignResult>;

  /**
   * Pauses a campaign.
   */
  pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult>;

  /**
   * Resumes/activates a campaign.
   */
  activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult>;

  /**
   * Deletes a campaign.
   */
  deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Creates an ad creative.
   */
  createCreative(
    credentials: AdAccountCredentials,
    accountId: string,
    externalCampaignId: string,
    input: CreateCreativeInput,
  ): Promise<AdProviderCreativeResult>;

  /**
   * Gets campaign metrics/analytics.
   */
  getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult>;
}

// ============================================
// Credit/Pricing Types
// ============================================

export const AD_CREDIT_RATES = {
  // Campaign management operations
  createCampaign: 0.5,
  createCreative: 0.25,

  // Ad spend markup (multiplier on actual spend)
  spendMarkup: {
    meta: 1.1,
    google: 1.1,
    tiktok: 1.1,
  },

  // Analytics/reports
  detailedAnalytics: 0.1,
} as const;

export function calculateSpendCredits(platform: AdPlatform, amount: number): number {
  const markup = AD_CREDIT_RATES.spendMarkup[platform] || 1.1;
  return amount * markup;
}
