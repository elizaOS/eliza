import {
  type AdAccount,
  type AdAudienceSegment,
  type AdCampaign,
  type AdCreative,
  adAccountsRepository,
  adAudienceSegmentsRepository,
  adCampaignsRepository,
  adConversionsRepository,
  adCreativesRepository,
  adReportSharesRepository,
  adTransactionsRepository,
} from "../../../db/repositories";
import { NotFoundError, ValidationError } from "../../api/cloud-worker-errors";
import { logger } from "../../utils/logger";
import { type ContentSafetyReview, contentSafetyService } from "../content-safety";
import { creditsService } from "../credits";
import { secretsService } from "../secrets";
import { googleAdsProvider } from "./providers/google";
import { linkedinAdsProvider } from "./providers/linkedin";
import { metaAdsProvider } from "./providers/meta";
import { programmaticDspProvider } from "./providers/programmatic-dsp";
import { redditAdsProvider } from "./providers/reddit";
import { snapAdsProvider } from "./providers/snap";
import { tiktokAdsProvider } from "./providers/tiktok";
import { xTwitterAdsProvider } from "./providers/x-twitter";
import { DaypartingScheduleSchema } from "./schemas";
import type {
  AdAccountCredentials,
  AdPlatform,
  AdProvider,
  AdProviderMediaStatusResult,
  AdProviderMediaUploadResult,
  CampaignDaypartingSchedule,
  CampaignMetrics,
  CampaignPerformanceReport,
  CampaignReportShare,
  CampaignTargeting,
  ConnectAccountInput,
  CreateAttributionLinkInput,
  CreateAudienceSegmentInput,
  CreateCampaignInput,
  CreateCampaignReportShareInput,
  CreateCreativeInput,
  CreativeMedia,
  DuplicateCampaignInput,
  RecordConversionInput,
  RecordConversionResult,
  UpdateAudienceSegmentInput,
  UpdateCampaignInput,
  UpdateCreativeInput,
  UploadMediaInput,
} from "./types";
import { AD_CREDIT_RATES, calculateSpendCredits } from "./types";

export * from "./schemas";
export * from "./types";

// Provider registry
const providers: Record<AdPlatform, AdProvider | null> = {
  meta: metaAdsProvider,
  google: googleAdsProvider,
  tiktok: tiktokAdsProvider,
  snap: snapAdsProvider,
  "x-twitter": xTwitterAdsProvider,
  reddit: redditAdsProvider,
  linkedin: linkedinAdsProvider,
  "programmatic-dsp": programmaticDspProvider,
};

const REPORT_TOKEN_BYTES = 24;

function safeDiv(numerator: number, denominator: number, multiplier = 1): number {
  return denominator > 0 ? (numerator / denominator) * multiplier : 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function randomReportToken(): string {
  const bytes = new Uint8Array(REPORT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

class AdvertisingService {
  private textEncoder = new TextEncoder();

  getSupportedPlatforms(): AdPlatform[] {
    return Object.entries(providers)
      .filter(([_, p]) => p !== null)
      .map(([platform]) => platform as AdPlatform);
  }

  private campaignSafetyText(input: CreateCampaignInput | UpdateCampaignInput): string[] {
    const text = [
      "name" in input ? `Campaign name: ${input.name}` : undefined,
      "objective" in input && input.objective ? `Objective: ${input.objective}` : undefined,
      input.bidStrategy ? `Bid strategy: ${input.bidStrategy}` : undefined,
      input.optimizationGoal ? `Optimization goal: ${input.optimizationGoal}` : undefined,
    ];
    if (input.targeting) {
      text.push(`Targeting: ${JSON.stringify(input.targeting)}`);
    }
    return text.filter((value): value is string => Boolean(value));
  }

  private creativeSafetyText(input: {
    name?: string | null;
    headline?: string | null;
    primaryText?: string | null;
    description?: string | null;
    callToAction?: string | null;
    destinationUrl?: string | null;
  }): string[] {
    return [
      "name" in input ? `Creative name: ${input.name}` : undefined,
      input.headline ? `Headline: ${input.headline}` : undefined,
      input.primaryText ? `Primary text: ${input.primaryText}` : undefined,
      input.description ? `Description: ${input.description}` : undefined,
      input.callToAction ? `Call to action: ${input.callToAction}` : undefined,
      input.destinationUrl ? `Destination URL: ${input.destinationUrl}` : undefined,
    ].filter((value): value is string => Boolean(value));
  }

  private creativeSafetyImageUrls(
    media:
      | Array<{
          url?: string | null;
          type?: string | null;
          thumbnailUrl?: string | null;
          thumbnail_url?: string | null;
        }>
      | undefined,
  ): string[] {
    return (media ?? []).flatMap((item) => {
      const urls: string[] = [];
      if (item.type === "image" && item.url) urls.push(item.url);
      const thumbnailUrl = item.thumbnailUrl ?? item.thumbnail_url;
      if (thumbnailUrl) urls.push(thumbnailUrl);
      return urls;
    });
  }

  private contentSafetyMetadata(review: ContentSafetyReview) {
    const metadata: NonNullable<AdCreative["metadata"]>["content_safety"] = {
      provider: review.provider,
      flagged: review.flagged,
      flaggedCategories: review.flaggedCategories,
      issues: review.issues,
    };
    if (review.model) metadata.model = review.model;
    if (review.moderationId) metadata.moderationId = review.moderationId;
    return metadata;
  }

  private normalizeDayparting(
    schedule: CampaignDaypartingSchedule | null | undefined,
  ): CampaignDaypartingSchedule | undefined {
    if (schedule === null || schedule === undefined) {
      return undefined;
    }
    const parsed = DaypartingScheduleSchema.safeParse(schedule);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(first?.message || "Invalid campaign dayparting schedule");
    }
    return {
      timezone: parsed.data.timezone,
      windows: parsed.data.windows.map((window) => ({
        daysOfWeek: [...new Set(window.daysOfWeek)].sort((a, b) => a - b),
        startTime: window.startTime,
        endTime: window.endTime,
      })),
    };
  }

  private campaignDayparting(campaign: AdCampaign): CampaignDaypartingSchedule | null {
    const parsed = DaypartingScheduleSchema.safeParse(campaign.metadata.dayparting);
    return parsed.success ? parsed.data : null;
  }

  private assertProviderCanApplyDayparting(platform: AdPlatform): void {
    if (platform !== "meta") {
      throw new Error("Campaign dayparting is currently supported only for Meta ad accounts");
    }
  }

  getProvider(platform: AdPlatform): AdProvider {
    const provider = providers[platform];
    if (!provider) {
      throw new Error(`Advertising platform ${platform} is not supported`);
    }
    return provider;
  }

  private assertBidControlsSupported(
    platform: AdPlatform,
    input: Pick<CreateCampaignInput | UpdateCampaignInput, "bidStrategy" | "optimizationGoal">,
  ): void {
    if ((input.bidStrategy || input.optimizationGoal) && platform === "tiktok") {
      throw ValidationError(
        "TikTok campaign creation does not support campaign-level bid strategy controls through this adapter",
      );
    }
  }

  private normalizeSpendCapCredits(value: number | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isFinite(value) || value <= 0) {
      throw ValidationError("Spend cap must be a positive credit amount");
    }
    return value.toFixed(2);
  }

  private async assertAccountSpendCapAllowsAllocation(input: {
    account: AdAccount;
    newCampaignCredits: number;
    excludeCampaignId?: string;
  }): Promise<void> {
    if (!input.account.spend_cap_credits) return;
    const existingAllocated = await adCampaignsRepository.sumCreditsAllocatedByAdAccount(
      input.account.id,
      { excludeCampaignId: input.excludeCampaignId },
    );
    const cap = Number(input.account.spend_cap_credits);
    if (existingAllocated + input.newCampaignCredits > cap + 1e-9) {
      throw ValidationError(
        `Ad account spend cap would be exceeded: ${(
          existingAllocated + input.newCampaignCredits
        ).toFixed(2)} credits requested against ${cap.toFixed(2)} cap`,
      );
    }
  }

  private assertCampaignSpendCapAllowsAllocation(input: {
    spendCapCredits: string | null | undefined;
    newCampaignCredits: number;
  }): void {
    if (!input.spendCapCredits) return;
    const cap = Number(input.spendCapCredits);
    if (input.newCampaignCredits > cap + 1e-9) {
      throw ValidationError(
        `Campaign spend cap would be exceeded: ${input.newCampaignCredits.toFixed(
          2,
        )} credits requested against ${cap.toFixed(2)} cap`,
      );
    }
  }

  private toDbTargeting(targeting: CampaignTargeting = {}) {
    return {
      locations: targeting.locations,
      age_min: targeting.ageMin,
      age_max: targeting.ageMax,
      genders: targeting.genders,
      interests: targeting.interests,
      behaviors: targeting.behaviors,
      custom_audiences: targeting.customAudiences,
      excluded_audiences: targeting.excludedAudiences,
      placements: targeting.placements,
      languages: targeting.languages,
    };
  }

  private fromDbTargeting(targeting: NonNullable<AdCampaign["targeting"]>): CampaignTargeting {
    return {
      locations: targeting.locations,
      ageMin: targeting.age_min,
      ageMax: targeting.age_max,
      genders: targeting.genders,
      interests: targeting.interests,
      behaviors: targeting.behaviors,
      customAudiences: targeting.custom_audiences,
      excludedAudiences: targeting.excluded_audiences,
      placements: targeting.placements,
      languages: targeting.languages,
    };
  }

  private serializeAudienceSegment(segment: AdAudienceSegment) {
    return {
      id: segment.id,
      organizationId: segment.organization_id,
      name: segment.name,
      description: segment.description,
      targeting: this.fromDbTargeting(segment.targeting),
      createdAt: segment.created_at,
      updatedAt: segment.updated_at,
    };
  }

  private async resolveAudienceTargeting(
    organizationId: string,
    input: Pick<CreateCampaignInput | UpdateCampaignInput, "audienceSegmentId" | "targeting">,
  ): Promise<CampaignTargeting | undefined> {
    if (!input.audienceSegmentId) {
      return input.targeting;
    }
    const segment = await adAudienceSegmentsRepository.findById(input.audienceSegmentId);
    if (!segment || segment.organization_id !== organizationId) {
      throw new Error("Audience segment not found");
    }
    return this.fromDbTargeting(segment.targeting);
  }

  private assertNoPostSyncTargetingUpdate(input: UpdateCampaignInput): void {
    if (input.targeting || input.audienceSegmentId) {
      throw ValidationError(
        "Campaign targeting cannot be updated after platform sync; create a new campaign with the desired audience segment",
      );
    }
  }

  async listAudienceSegments(organizationId: string) {
    const segments = await adAudienceSegmentsRepository.listByOrganization(organizationId);
    return segments.map((segment) => this.serializeAudienceSegment(segment));
  }

  async getAudienceSegment(segmentId: string, organizationId: string) {
    const segment = await adAudienceSegmentsRepository.findById(segmentId);
    if (!segment || segment.organization_id !== organizationId) {
      return undefined;
    }
    return this.serializeAudienceSegment(segment);
  }

  async createAudienceSegment(input: CreateAudienceSegmentInput) {
    const segment = await adAudienceSegmentsRepository.create({
      organization_id: input.organizationId,
      created_by_user_id: input.userId,
      name: input.name,
      description: input.description,
      targeting: this.toDbTargeting(input.targeting),
    });
    logger.info("[Advertising] Audience segment created", {
      segmentId: segment.id,
      organizationId: input.organizationId,
    });
    return this.serializeAudienceSegment(segment);
  }

  async updateAudienceSegment(
    segmentId: string,
    organizationId: string,
    input: UpdateAudienceSegmentInput,
  ) {
    const updated = await adAudienceSegmentsRepository.update(segmentId, organizationId, {
      name: input.name,
      description: input.description,
      targeting: input.targeting ? this.toDbTargeting(input.targeting) : undefined,
    });
    if (!updated) {
      throw new Error("Audience segment not found");
    }
    logger.info("[Advertising] Audience segment updated", { segmentId, organizationId });
    return this.serializeAudienceSegment(updated);
  }

  async deleteAudienceSegment(segmentId: string, organizationId: string): Promise<void> {
    const segment = await adAudienceSegmentsRepository.findById(segmentId);
    if (!segment || segment.organization_id !== organizationId) {
      throw new Error("Audience segment not found");
    }
    await adAudienceSegmentsRepository.delete(segmentId, organizationId);
    logger.info("[Advertising] Audience segment deleted", { segmentId, organizationId });
  }

  async applyAudienceSegmentToCampaign(
    segmentId: string,
    campaignId: string,
    organizationId: string,
  ): Promise<AdCampaign> {
    return await this.updateCampaign(campaignId, organizationId, { audienceSegmentId: segmentId });
  }

  private base64UrlEncode(value: string | Uint8Array): string {
    const bytes = typeof value === "string" ? this.textEncoder.encode(value) : value;
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  }

  private base64UrlDecode(value: string): string {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return atob(padded);
  }

  private async hmacSha256(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      this.textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, this.textEncoder.encode(message));
    return this.base64UrlEncode(new Uint8Array(signature));
  }

  private constantTimeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i += 1) {
      diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return diff === 0;
  }

  private newAttributionSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return this.base64UrlEncode(bytes);
  }

  private slugForUtm(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug || "campaign";
  }

  private async ensureAttributionSecret(campaign: AdCampaign): Promise<{
    campaign: AdCampaign;
    secret: string;
  }> {
    const existing = campaign.metadata?.attribution_token_secret;
    if (existing) {
      return { campaign, secret: existing };
    }

    const secret = this.newAttributionSecret();
    const updated = await adCampaignsRepository.update(campaign.id, {
      metadata: {
        ...(campaign.metadata ?? {}),
        attribution_token_secret: secret,
      },
    });
    if (!updated) {
      throw new Error("Campaign not found");
    }
    return { campaign: updated, secret };
  }

  async getAttributionToken(campaignId: string, organizationId: string) {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }
    const { campaign: signedCampaign, secret } = await this.ensureAttributionSecret(campaign);
    const payload = this.base64UrlEncode(
      JSON.stringify({
        v: 1,
        c: signedCampaign.id,
        o: signedCampaign.organization_id,
        a: signedCampaign.app_id,
      }),
    );
    const signature = await this.hmacSha256(secret, payload);
    return {
      campaignId: signedCampaign.id,
      appId: signedCampaign.app_id,
      token: `${payload}.${signature}`,
    };
  }

  private async verifyAttributionToken(token: string): Promise<AdCampaign> {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) {
      throw new Error("Invalid attribution token");
    }

    let parsed: { v?: number; c?: string; o?: string; a?: string | null };
    try {
      parsed = JSON.parse(this.base64UrlDecode(payload));
    } catch {
      throw new Error("Invalid attribution token");
    }
    if (parsed.v !== 1 || !parsed.c || !parsed.o) {
      throw new Error("Invalid attribution token");
    }

    const campaign = await adCampaignsRepository.findById(parsed.c);
    if (!campaign || campaign.organization_id !== parsed.o || campaign.app_id !== parsed.a) {
      throw new Error("Invalid attribution token");
    }
    const secret = campaign.metadata?.attribution_token_secret;
    if (!secret) {
      throw new Error("Invalid attribution token");
    }
    const expected = await this.hmacSha256(secret, payload);
    if (!this.constantTimeEqual(signature, expected)) {
      throw new Error("Invalid attribution token");
    }
    return campaign;
  }

  async createAttributionLink(input: CreateAttributionLinkInput) {
    const campaign = await adCampaignsRepository.findById(input.campaignId);
    if (!campaign || campaign.organization_id !== input.organizationId) {
      throw new Error("Campaign not found");
    }

    if (input.creativeId) {
      const creative = await adCreativesRepository.findById(input.creativeId);
      if (!creative || creative.campaign_id !== campaign.id) {
        throw new Error("Creative not found");
      }
    }

    const utmSource = input.source ?? campaign.platform;
    const utmMedium = input.medium ?? "paid";
    const utmCampaign = this.slugForUtm(campaign.name);
    const url = new URL(input.destinationUrl);
    url.searchParams.set("utm_source", utmSource);
    url.searchParams.set("utm_medium", utmMedium);
    url.searchParams.set("utm_campaign", utmCampaign);
    if (input.content) url.searchParams.set("utm_content", input.content);
    if (input.term) url.searchParams.set("utm_term", input.term);

    const existing = await adConversionsRepository.findAttributionLink({
      campaignId: campaign.id,
      creativeId: input.creativeId,
      destinationUrl: input.destinationUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent: input.content,
      utmTerm: input.term,
    });
    const link =
      existing ??
      (await adConversionsRepository.createAttributionLink({
        organization_id: campaign.organization_id,
        campaign_id: campaign.id,
        creative_id: input.creativeId,
        app_id: campaign.app_id,
        destination_url: input.destinationUrl,
        utm_url: url.toString(),
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        utm_content: input.content,
        utm_term: input.term,
      }));

    return {
      id: link.id,
      campaignId: link.campaign_id,
      creativeId: link.creative_id,
      destinationUrl: link.destination_url,
      utmUrl: link.utm_url,
      utm: {
        source: link.utm_source,
        medium: link.utm_medium,
        campaign: link.utm_campaign,
        content: link.utm_content,
        term: link.utm_term,
      },
    };
  }

  async recordConversion(input: RecordConversionInput): Promise<RecordConversionResult> {
    const campaign = await this.verifyAttributionToken(input.token);
    const recorded = await adConversionsRepository.recordConversion({
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      app_id: campaign.app_id,
      event_type: input.eventType,
      dedupe_key: input.dedupeKey,
      value: input.value === undefined ? undefined : input.value.toFixed(2),
      currency: input.currency ?? "USD",
      source_url: input.sourceUrl,
      referrer: input.referrer,
      user_agent: input.userAgent,
      occurred_at: input.occurredAt,
      metadata: input.metadata ?? {},
    });

    logger.info("[Advertising] Conversion event recorded", {
      campaignId: campaign.id,
      organizationId: campaign.organization_id,
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      inserted: recorded.inserted,
    });

    return {
      eventId: recorded.event.id,
      campaignId: campaign.id,
      organizationId: campaign.organization_id,
      appId: campaign.app_id,
      inserted: recorded.inserted,
    };
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
      // Ad spend is money movement, so a newly-connected account starts
      // "pending" and cannot run campaigns until a platform operator approves
      // it (POST /api/v1/advertising/accounts/:id/approve, requireAdmin) — the
      // same operator-executes posture as fiat payouts/redemptions. This
      // prevents a stolen/abusive ad account from spending before review. (#11364)
      status: "pending",
    });

    logger.info("[Advertising] Ad account connected", {
      accountId: account.id,
      platform: input.platform,
    });

    return account;
  }

  /**
   * Approve a pending ad account so it can run campaigns. Platform-operator
   * action (requireAdmin at the route) — the same operator-executes posture as
   * fiat payouts; an org owner can never self-approve their own ad account. (#11364)
   */
  async approveAccount(accountId: string): Promise<AdAccount> {
    const account = await adAccountsRepository.findById(accountId);
    if (!account) {
      throw new Error("Ad account not found");
    }
    if (account.status === "active") {
      return account; // idempotent
    }
    if (account.status !== "pending") {
      throw new Error(
        `Ad account cannot be approved from status "${account.status}" (only "pending" accounts can be approved)`,
      );
    }
    const updated = await adAccountsRepository.updateStatus(accountId, "active");
    if (!updated) {
      throw new Error("Ad account not found");
    }
    logger.info("[Advertising] Ad account approved", { accountId });
    return updated;
  }

  /**
   * Reject or suspend an ad account so it cannot run campaigns. Platform-operator
   * action (requireAdmin at the route). Covers both rejecting a pending account
   * on review and suspending an active account for ToS. (#11364)
   */
  async rejectAccount(accountId: string): Promise<AdAccount> {
    const account = await adAccountsRepository.findById(accountId);
    if (!account) {
      throw new Error("Ad account not found");
    }
    if (account.status === "suspended") {
      return account; // idempotent
    }
    const updated = await adAccountsRepository.updateStatus(accountId, "suspended");
    if (!updated) {
      throw new Error("Ad account not found");
    }
    logger.info("[Advertising] Ad account rejected/suspended", { accountId });
    return updated;
  }

  async setAccountSpendCap(
    accountId: string,
    organizationId: string,
    spendCapCredits: number | null,
  ): Promise<AdAccount> {
    const account = await adAccountsRepository.findById(accountId);
    if (!account || account.organization_id !== organizationId) {
      throw new Error("Ad account not found");
    }
    const normalized = this.normalizeSpendCapCredits(spendCapCredits) ?? null;
    const result = await adAccountsRepository.updateSpendCapWithAllocationCheck(
      accountId,
      organizationId,
      normalized,
    );
    if (result.status === "not_found") {
      throw new Error("Ad account not found");
    }
    if (result.status === "cap_exceeded") {
      throw ValidationError(
        `Ad account already has ${result.allocated.toFixed(
          2,
        )} allocated credits, which exceeds the requested ${result.cap.toFixed(2)} cap`,
      );
    }
    logger.info("[Advertising] Ad account spend cap updated", {
      accountId,
      organizationId,
      spendCapCredits: normalized,
    });
    return result.account;
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

  async uploadMedia(
    organizationId: string,
    adAccountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    const account = await adAccountsRepository.findById(adAccountId);
    if (!account || account.organization_id !== organizationId) {
      throw new Error("Ad account not found");
    }

    const provider = this.getProvider(account.platform);
    if (!provider.uploadMedia) {
      throw new Error(`Advertising platform ${account.platform} does not support media upload`);
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "advertising_creative",
      organizationId,
      text: [
        input.name ? `Media name: ${input.name}` : undefined,
        `Media type: ${input.type}`,
        `Media URL: ${input.url}`,
      ],
      imageUrls:
        input.type === "image"
          ? [input.url]
          : input.thumbnailUrl
            ? [input.thumbnailUrl]
            : undefined,
      metadata: { platform: account.platform, adAccountId },
    });

    const credentials = await this.getCredentials(account);
    const result = await provider.uploadMedia(credentials, account.external_account_id, input);
    if (!result.success) {
      throw new Error(result.error || "Failed to upload media to advertising platform");
    }
    return result;
  }

  async getMediaStatus(
    organizationId: string,
    adAccountId: string,
    providerAssetResourceName: string,
  ): Promise<AdProviderMediaStatusResult> {
    const account = await adAccountsRepository.findById(adAccountId);
    if (!account || account.organization_id !== organizationId) {
      throw new Error("Ad account not found");
    }

    const provider = this.getProvider(account.platform);
    if (!provider.getMediaStatus) {
      return {
        success: true,
        providerAssetId: providerAssetResourceName,
        providerAssetResourceName,
        status: "AVAILABLE",
        ready: true,
      };
    }

    const credentials = await this.getCredentials(account);
    const result = await provider.getMediaStatus(credentials, account.external_account_id, {
      providerAssetResourceName,
    });
    if (!result.success) {
      throw new Error(result.error || "Failed to get media status from advertising platform");
    }
    return result;
  }

  private async prepareCreativeMediaForProvider(
    organizationId: string,
    account: AdAccount,
    provider: AdProvider,
    credentials: AdAccountCredentials,
    input: CreateCreativeInput,
  ): Promise<CreativeMedia[]> {
    if (!provider.uploadMedia || input.media.length === 0) {
      return input.media;
    }

    const prepared: CreativeMedia[] = [];
    for (const media of input.media) {
      if (media.providerAssetId) {
        prepared.push(media);
      } else {
        const upload = await this.uploadMedia(organizationId, account.id, {
          name: `${input.name}-${media.order}`,
          type: media.type,
          url: media.url,
          thumbnailUrl: media.thumbnailUrl,
        });
        if (!upload.providerAssetId) {
          throw new Error("Advertising media upload returned no provider asset id");
        }
        prepared.push({
          ...media,
          providerAssetId: upload.providerAssetId,
          thumbnailUrl: media.thumbnailUrl ?? upload.providerAssetUrl,
        });
      }

      if (
        (account.platform === "tiktok" || account.platform === "google") &&
        media.type === "video" &&
        media.thumbnailUrl &&
        !input.media.some((candidate) => candidate.type === "image")
      ) {
        const thumbnailUpload = await provider.uploadMedia(
          credentials,
          account.external_account_id,
          {
            name: `${input.name}-thumbnail`,
            type: "image",
            url: media.thumbnailUrl,
          },
        );
        if (!thumbnailUpload.success || !thumbnailUpload.providerAssetId) {
          throw new Error(
            thumbnailUpload.error || `Failed to upload ${account.platform} video thumbnail`,
          );
        }
        prepared.push({
          id: crypto.randomUUID(),
          source: media.source,
          url: media.thumbnailUrl,
          providerAssetId: thumbnailUpload.providerAssetId,
          type: "image",
          order: media.order + 1,
        });
      }
    }

    return prepared;
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

  async getCampaignDayparting(
    campaignId: string,
    organizationId: string,
  ): Promise<CampaignDaypartingSchedule | null> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }
    return this.campaignDayparting(campaign);
  }

  async createCampaign(input: CreateCampaignInput): Promise<AdCampaign> {
    logger.info("[Advertising] Creating campaign", {
      organizationId: input.organizationId,
      name: input.name,
    });
    const dayparting = this.normalizeDayparting(input.dayparting);

    const account = await adAccountsRepository.findById(input.adAccountId);
    if (!account || account.organization_id !== input.organizationId) {
      throw new Error("Ad account not found");
    }
    // Only an approved (active) ad account may spend — a pending/suspended/
    // disconnected account cannot create campaigns. (#11364)
    if (account.status !== "active") {
      throw new Error(
        `Ad account is not active (status: ${account.status}); it must be approved before running campaigns`,
      );
    }
    if (dayparting) {
      this.assertProviderCanApplyDayparting(account.platform);
    }
    this.assertBidControlsSupported(account.platform, input);

    const targeting = await this.resolveAudienceTargeting(input.organizationId, input);
    const campaignInput: CreateCampaignInput = {
      ...input,
      targeting,
      audienceSegmentId: undefined,
      dayparting,
    };
    const budgetCredits = calculateSpendCredits(account.platform, input.budgetAmount);
    const campaignSpendCap = this.normalizeSpendCapCredits(input.spendCapCredits);
    this.assertCampaignSpendCapAllowsAllocation({
      spendCapCredits: campaignSpendCap,
      newCampaignCredits: budgetCredits,
    });
    await this.assertAccountSpendCapAllowsAllocation({
      account,
      newCampaignCredits: budgetCredits,
    });

    await contentSafetyService.assertSafeForPublicUse({
      surface: "advertising_campaign",
      organizationId: input.organizationId,
      appId: input.appId,
      text: this.campaignSafetyText(campaignInput),
      metadata: { platform: account.platform, adAccountId: input.adAccountId },
    });

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
      await Promise.all([
        creditsService.refundCredits({
          organizationId: input.organizationId,
          amount: AD_CREDIT_RATES.createCampaign,
          description: "Refund: Campaign creation failed while recording campaign charge",
          metadata: {},
        }),
        creditsService.refundCredits({
          organizationId: input.organizationId,
          amount: budgetCredits,
          description: "Refund: Campaign budget allocation transaction was not recorded",
          metadata: {},
        }),
      ]);
      throw new Error("Failed to record budget deduction transaction");
    }

    // Create campaign on the platform
    const credentials = await this.getCredentials(account);
    const provider = this.getProvider(account.platform);

    const result = await provider.createCampaign(
      credentials,
      account.external_account_id,
      campaignInput,
    );

    if (!result.success) {
      // Refund all credits
      await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: AD_CREDIT_RATES.createCampaign + budgetCredits,
        description: `Refund: Campaign creation failed - ${result.error}`,
        metadata: {},
      });
      throw new Error(result.error || "Failed to create campaign on platform");
    }

    let campaign: AdCampaign | null = null;
    try {
      // Create campaign record
      const allocation = await adCampaignsRepository.createWithAccountSpendCapCheck(
        {
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
          spend_cap_credits: campaignSpendCap,
          start_date: input.startDate,
          end_date: input.endDate,
          targeting: targeting ? this.toDbTargeting(targeting) : {},
          app_id: input.appId,
          metadata: {
            ...(input.bidStrategy ? { bid_strategy: input.bidStrategy } : {}),
            ...(input.optimizationGoal ? { optimization_goal: input.optimizationGoal } : {}),
            ...(dayparting
              ? {
                  dayparting,
                  dayparting_provider_synced_at: new Date().toISOString(),
                }
              : {}),
          },
        },
        budgetCredits,
      );
      if (allocation.status === "cap_exceeded") {
        throw ValidationError(
          `Ad account spend cap would be exceeded: ${allocation.allocated.toFixed(
            2,
          )} credits requested against ${allocation.cap.toFixed(2)} cap`,
        );
      }
      if (allocation.status !== "created") {
        throw new Error("Ad account changed concurrently; please retry");
      }
      campaign = allocation.campaign;

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
    } catch (error) {
      logger.error("[Advertising] Local campaign persistence failed after provider create", {
        organizationId: input.organizationId,
        externalCampaignId: result.externalCampaignId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (result.externalCampaignId) {
        await provider
          .deleteCampaign(credentials, result.externalCampaignId)
          .catch((deleteError) => {
            logger.error("[Advertising] Failed to compensate provider campaign create", {
              externalCampaignId: result.externalCampaignId,
              error: deleteError instanceof Error ? deleteError.message : String(deleteError),
            });
          });
      }
      if (campaign) {
        await adCampaignsRepository.delete(campaign.id).catch((deleteError) => {
          logger.error("[Advertising] Failed to remove partially persisted campaign", {
            campaignId: campaign?.id,
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          });
        });
      }
      await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: AD_CREDIT_RATES.createCampaign + budgetCredits,
        description: "Refund: Campaign creation failed after platform sync",
        metadata: { externalCampaignId: result.externalCampaignId },
      });
      throw error;
    }

    if (!campaign) {
      throw new Error("Campaign creation failed before local campaign was persisted");
    }

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
    // No ad-platform adapter applies bid-control changes to a live campaign
    // (Meta bid controls live on the ad set created with the campaign;
    // Google/TikTok updates only push name/budget/dates). Reject explicitly
    // instead of persisting local metadata the platform never receives.
    if (input.bidStrategy !== undefined || input.optimizationGoal !== undefined) {
      throw ValidationError(
        "Bid strategy and optimization goal can only be set at campaign creation; ad platform adapters do not apply bid-control changes to live campaigns",
      );
    }

    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }
    const requestedCampaignSpendCap =
      input.spendCapCredits === undefined
        ? campaign.spend_cap_credits
        : this.normalizeSpendCapCredits(input.spendCapCredits);
    if (input.spendCapCredits !== undefined) {
      this.assertCampaignSpendCapAllowsAllocation({
        spendCapCredits: requestedCampaignSpendCap,
        newCampaignCredits: Number(campaign.credits_allocated),
      });
    }

    if (!campaign.external_campaign_id) {
      // Only the locally-stored dayparting schedule can change before the
      // campaign is synced. Reject mixed payloads instead of silently applying
      // the schedule and dropping the rest.
      if (input.dayparting === undefined && input.spendCapCredits === undefined) {
        throw new Error("Campaign not synced with platform");
      }
      if (
        input.name !== undefined ||
        input.budgetAmount !== undefined ||
        input.startDate !== undefined ||
        input.endDate !== undefined ||
        input.targeting !== undefined ||
        input.audienceSegmentId !== undefined
      ) {
        throw new Error(
          "Campaign not synced with platform; only dayparting and spend caps can be updated before sync",
        );
      }
    }
    const dayparting =
      input.dayparting === undefined ? undefined : this.normalizeDayparting(input.dayparting);

    if (input.dayparting !== undefined && campaign.external_campaign_id) {
      throw new Error(
        "Campaign dayparting cannot be changed after provider sync; create or duplicate a scheduled campaign instead",
      );
    }

    if (!campaign.external_campaign_id) {
      const metadata = {
        ...campaign.metadata,
        ...(dayparting ? { dayparting } : {}),
      };
      if (input.dayparting === null) {
        delete metadata.dayparting;
      }
      const updated = await adCampaignsRepository.update(campaignId, {
        metadata,
        spend_cap_credits:
          input.spendCapCredits === undefined ? undefined : requestedCampaignSpendCap,
      });
      if (!updated) {
        throw new Error("Campaign not found");
      }
      logger.info("[Advertising] Campaign dayparting updated locally", { campaignId });
      return updated;
    }

    this.assertNoPostSyncTargetingUpdate(input);

    const targeting = await this.resolveAudienceTargeting(organizationId, input);
    const campaignInput: UpdateCampaignInput = {
      ...input,
      targeting,
      audienceSegmentId: undefined,
    };

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    if (account.status !== "active") {
      throw new Error(
        `Ad account is not active (status: ${account.status}); it must be approved before running campaigns`,
      );
    }

    const provider = this.getProvider(account.platform);
    const credentials = await this.getCredentials(account);

    // Reconcile the credit hold when the budget changes. createCampaign charged
    // budget*markup up front (stored as credits_allocated); a budget change here
    // goes LIVE on the ad platform, but previously a raise charged nothing and a
    // cut refunded nothing — breaking the budget↔credits_allocated invariant (and
    // over-refunding at delete). Charge an increase BEFORE pushing it live
    // (fail-closed on insufficient balance); refund a decrease AFTER the platform
    // accepts it; keep credits_allocated in sync.
    let newCreditsAllocated: number | undefined;
    let budgetCreditDelta = 0;
    if (input.budgetAmount !== undefined) {
      newCreditsAllocated = calculateSpendCredits(account.platform, input.budgetAmount);
      this.assertCampaignSpendCapAllowsAllocation({
        spendCapCredits: requestedCampaignSpendCap,
        newCampaignCredits: newCreditsAllocated,
      });
      await this.assertAccountSpendCapAllowsAllocation({
        account,
        newCampaignCredits: newCreditsAllocated,
        excludeCampaignId: campaignId,
      });
      budgetCreditDelta = newCreditsAllocated - parseFloat(campaign.credits_allocated);
      if (budgetCreditDelta > 0) {
        const debit = await creditsService.deductCredits({
          organizationId,
          amount: budgetCreditDelta,
          description: `Ad budget increase: ${campaign.name}`,
          metadata: { type: "ad_budget_increase", campaignId },
        });
        if (!debit.success) {
          throw new Error("Insufficient credit balance for the budget increase");
        }
      }
    }

    // Post-sync dayparting changes are rejected above, so `input` never carries
    // a schedule here — providers cannot update adset schedules in place.
    const result = await provider.updateCampaign(
      credentials,
      campaign.external_campaign_id,
      campaignInput,
    );

    if (!result.success) {
      // Platform rejected the change — undo any increase charge we just made.
      if (budgetCreditDelta > 0) {
        await creditsService.refundCredits({
          organizationId,
          amount: budgetCreditDelta,
          description: `Ad budget increase refund (platform rejected): ${campaign.name}`,
          metadata: { type: "ad_budget_increase_refund", campaignId },
        });
      }
      throw new Error(result.error || "Failed to update campaign");
    }

    const updateData = {
      name: input.name,
      budget_amount: input.budgetAmount ? String(input.budgetAmount) : undefined,
      spend_cap_credits:
        input.spendCapCredits === undefined ? undefined : requestedCampaignSpendCap,
      ...(newCreditsAllocated !== undefined
        ? { credits_allocated: String(newCreditsAllocated) }
        : {}),
      start_date: input.startDate,
      end_date: input.endDate,
      targeting: targeting ? this.toDbTargeting(targeting) : undefined,
    };

    let updated: AdCampaign | undefined;
    if (budgetCreditDelta < 0 && newCreditsAllocated !== undefined) {
      // Platform accepted a budget DECREASE. Two money leaks fixed here (#11292):
      //  1. Over-refund after spend: the old code refunded the FULL allocation
      //     delta, ignoring spend. Refund only the genuinely-UNUSED portion (the
      //     same clamp deleteCampaign applies), so a decrease can never refund
      //     credits already spent on real impressions.
      //  2. Concurrent double-refund: claim the allocation change atomically
      //     (CAS on the observed credits_allocated) so only ONE of two
      //     simultaneous decreases refunds.
      // credits_allocated stays == newBudget*markup (never clamp the STORED
      // allocation) so the markup derived at delete (allocated/budget) stays
      // correct — only the REFUND is clamped.
      const oldAllocated = parseFloat(campaign.credits_allocated);
      const spentCredits = await this.computeCreditsSpent(campaign);
      const freed = oldAllocated - newCreditsAllocated;
      const unused = Math.max(0, oldAllocated - spentCredits);
      const refundAmount = Math.max(0, Math.min(freed, unused));

      updated = await adCampaignsRepository.claimAllocationChange(
        campaignId,
        organizationId,
        campaign.credits_allocated,
        updateData,
      );
      if (!updated) {
        // Another budget change moved credits_allocated between our read and
        // this atomic write — refuse rather than risk a double refund. Safe to
        // retry (the campaign was not modified by this call).
        throw new Error("Campaign budget changed concurrently; please retry");
      }
      if (refundAmount > 0) {
        await creditsService.refundCredits({
          organizationId,
          amount: refundAmount,
          description: `Ad budget decrease refund: ${campaign.name}`,
          metadata: { type: "ad_budget_decrease_refund", campaignId },
        });
      }
    } else if (budgetCreditDelta > 0 && newCreditsAllocated !== undefined) {
      const allocation = await adCampaignsRepository.claimAllocationChangeWithAccountSpendCapCheck(
        campaignId,
        organizationId,
        account.id,
        campaign.credits_allocated,
        newCreditsAllocated,
        updateData,
      );
      if (allocation.status === "cap_exceeded") {
        await provider
          .updateCampaign(credentials, campaign.external_campaign_id, {
            budgetAmount: Number(campaign.budget_amount),
          })
          .catch((revertError) => {
            logger.error("[Advertising] Failed to revert provider budget after account cap race", {
              campaignId,
              error: revertError instanceof Error ? revertError.message : String(revertError),
            });
          });
        await creditsService.refundCredits({
          organizationId,
          amount: budgetCreditDelta,
          description: `Ad budget increase refund (account cap exceeded): ${campaign.name}`,
          metadata: { type: "ad_budget_increase_refund", campaignId },
        });
        throw ValidationError(
          `Ad account spend cap would be exceeded: ${allocation.allocated.toFixed(
            2,
          )} credits requested against ${allocation.cap.toFixed(2)} cap`,
        );
      }
      if (allocation.status !== "updated") {
        await provider
          .updateCampaign(credentials, campaign.external_campaign_id, {
            budgetAmount: Number(campaign.budget_amount),
          })
          .catch((revertError) => {
            logger.error(
              "[Advertising] Failed to revert provider budget after concurrent campaign update",
              {
                campaignId,
                error: revertError instanceof Error ? revertError.message : String(revertError),
              },
            );
          });
        await creditsService.refundCredits({
          organizationId,
          amount: budgetCreditDelta,
          description: `Ad budget increase refund (concurrent update): ${campaign.name}`,
          metadata: { type: "ad_budget_increase_refund", campaignId },
        });
        throw new Error("Campaign budget changed concurrently; please retry");
      }
      updated = allocation.campaign;
    } else {
      updated = await adCampaignsRepository.update(campaignId, updateData);
    }

    logger.info("[Advertising] Campaign updated", { campaignId });

    return updated!;
  }

  async updateCampaignDayparting(
    campaignId: string,
    organizationId: string,
    schedule: CampaignDaypartingSchedule | null,
  ): Promise<AdCampaign> {
    return await this.updateCampaign(campaignId, organizationId, { dayparting: schedule });
  }

  async duplicateCampaign(
    campaignId: string,
    organizationId: string,
    input: DuplicateCampaignInput = {},
  ): Promise<{ campaign: AdCampaign; creativesCopied: number }> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    const duplicate = await adCampaignsRepository.create({
      organization_id: organizationId,
      ad_account_id: campaign.ad_account_id,
      name: input.name ?? `${campaign.name} Copy`,
      platform: campaign.platform,
      objective: campaign.objective,
      status: "draft",
      budget_type: campaign.budget_type,
      budget_amount: campaign.budget_amount,
      budget_currency: campaign.budget_currency,
      credits_allocated: "0.00",
      credits_spent: "0.00",
      total_spend: "0.00",
      total_impressions: 0,
      total_clicks: 0,
      total_conversions: 0,
      start_date: campaign.start_date,
      end_date: campaign.end_date,
      targeting: campaign.targeting,
      app_id: campaign.app_id,
      metadata: {
        ...campaign.metadata,
        source_campaign_id: campaign.id,
        external_ad_set_ids: undefined,
        external_ad_ids: undefined,
        dayparting_provider_synced_at: undefined,
        error_message: undefined,
        last_sync_at: undefined,
      },
    });

    const creatives = await adCreativesRepository.listByCampaign(campaign.id);
    for (const creative of creatives) {
      await adCreativesRepository.create({
        campaign_id: duplicate.id,
        name: creative.name,
        type: creative.type,
        status: "draft",
        headline: creative.headline,
        primary_text: creative.primary_text,
        description: creative.description,
        call_to_action: creative.call_to_action,
        destination_url: creative.destination_url,
        media: creative.media.map(({ providerAssetId: _providerAssetId, ...media }) => media),
        metadata: creative.metadata.content_safety
          ? { content_safety: creative.metadata.content_safety }
          : {},
      });
    }

    logger.info("[Advertising] Campaign duplicated", {
      sourceCampaignId: campaign.id,
      campaignId: duplicate.id,
      creativesCopied: creatives.length,
    });

    return { campaign: duplicate, creativesCopied: creatives.length };
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
    // Only an approved (active) ad account may spend — block starting a campaign
    // on a pending/suspended/disconnected account (e.g. suspended for ToS after
    // the campaign was created). (#11364)
    if (account.status !== "active") {
      throw new Error(
        `Ad account is not active (status: ${account.status}); it must be approved before running campaigns`,
      );
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

  /**
   * Credits genuinely spent for a campaign, honoring BOTH spend columns (#11151):
   *   - internal miniapp SSP spend → `credits_spent` (already in allocated-credit
   *     units, written by adSlotsRepository.recordServe per served impression).
   *   - external-provider spend → `total_spend` (USD; converted to allocated-
   *     credit units at the same markup applied at allocation). Best-effort
   *     refreshed from the provider first so a never-synced campaign can't
   *     under-count spend and over-refund.
   * SUMS the two measures and clamps to the allocation (restoring merged
   * #11255 semantics): the streams are additive, not alternative —
   * findEligibleAds serves EXTERNAL campaigns through the internal SSP too, so
   * credits_spent and total_spend accrue independently on one campaign, and
   * MAX would under-count dual-stream spend and over-refund. Shared by
   * deleteCampaign and the updateCampaign budget-decrease refund (#11292).
   */
  private async computeCreditsSpent(campaign: {
    id: string;
    organization_id: string;
    external_campaign_id: string | null;
    credits_allocated: string;
    budget_amount: string;
    credits_spent: string;
    total_spend: string;
  }): Promise<number> {
    let totalSpendUsd = parseFloat(campaign.total_spend);
    if (campaign.external_campaign_id) {
      try {
        const freshMetrics = await this.getCampaignMetrics(campaign.id, campaign.organization_id);
        if (Number.isFinite(Number(freshMetrics.spend))) {
          totalSpendUsd = Number(freshMetrics.spend);
        }
      } catch (metricsError) {
        logger.warn("[Advertising] spend refresh failed; using stored total_spend", {
          campaignId: campaign.id,
          error: metricsError instanceof Error ? metricsError.message : String(metricsError),
        });
      }
    }
    const creditsAllocated = parseFloat(campaign.credits_allocated);
    const budgetAmountUsd = parseFloat(campaign.budget_amount);
    const markup = budgetAmountUsd > 0 ? creditsAllocated / budgetAmountUsd : 1;
    const internalSpentCredits = Math.max(0, parseFloat(campaign.credits_spent));
    const externalSpentCredits = Math.max(0, totalSpendUsd) * markup;
    return Math.min(creditsAllocated, internalSpentCredits + externalSpentCredits);
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
        const result = await provider.deleteCampaign(credentials, campaign.external_campaign_id);
        if (!result.success) {
          throw new Error(result.error || "Failed to delete campaign on platform");
        }
      }
    }

    // Best-effort external spend refresh BEFORE the atomic claim, while the
    // row still exists — getCampaignMetrics persists the fresh total_spend
    // onto the row (updateMetrics), so the claimed row below carries it. Keeps
    // the #11151 protection against a never-synced campaign under-counting
    // spend and over-refunding.
    if (campaign.external_campaign_id) {
      try {
        await this.getCampaignMetrics(campaignId, organizationId);
      } catch (metricsError) {
        logger.warn("[Advertising] pre-delete spend refresh failed; using stored total_spend", {
          campaignId,
          error: metricsError instanceof Error ? metricsError.message : String(metricsError),
        });
      }
    }

    // Atomic claim: only the caller that actually removes the row refunds, so
    // two concurrent deletes (or a delete retried after a mid-op failure) can't
    // both refund the unused budget (#11292). claimDelete returns the row only
    // to the winner.
    const deleted = await adCampaignsRepository.claimDelete(campaignId, organizationId);
    if (!deleted) {
      logger.info("[Advertising] Campaign already deleted concurrently; skipping refund", {
        campaignId,
      });
      return;
    }

    // Refund from the CLAIMED row, never the pre-claim findById snapshot: a
    // concurrent budget DECREASE commits its lower credits_allocated (and
    // refunds the freed delta) before claimDelete removes the row, so a
    // snapshot-based refund would pay that freed budget out a second time —
    // and impressions served after the snapshot would be refunded too. The
    // two-column (#11151) spend logic lives in the shared helper; external
    // spend was already refreshed onto the row above and the row is gone now,
    // so skip the in-helper re-refresh (it could only fail and warn) by
    // passing external_campaign_id: null.
    const creditsSpent = await this.computeCreditsSpent({
      ...deleted,
      external_campaign_id: null,
    });
    const creditsRemaining = Math.max(0, parseFloat(deleted.credits_allocated) - creditsSpent);

    if (creditsRemaining > 0) {
      await creditsService.refundCredits({
        organizationId,
        amount: creditsRemaining,
        description: `Refund unused budget for deleted campaign: ${campaign.name}`,
        metadata: { campaignId, campaignName: campaign.name },
      });

      // The campaign row is already deleted by claimDelete, so a campaign_id
      // here would violate the ad_transactions FK (23503) and 500 every
      // refunding delete AFTER the refund committed — dropping the ledger row
      // (onDelete:'set null' rewrites existing rows; it does not permit a
      // dangling insert). Keep the deleted id in external_reference, matching
      // the merged #11255 fix this branch predates.
      await adTransactionsRepository.create({
        organization_id: organizationId,
        campaign_id: null,
        external_reference: campaignId,
        type: "refund",
        amount: String(creditsRemaining),
        currency: campaign.budget_currency,
        credits_amount: String(creditsRemaining),
        description: `Refund for deleted campaign: ${campaign.name}`,
      });
    }

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
      const firstParty = await adConversionsRepository.getCampaignRollup(campaignId, dateRange);
      // Return stored metrics if not synced
      return {
        spend: parseFloat(campaign.total_spend),
        impressions: campaign.total_impressions,
        clicks: campaign.total_clicks,
        conversions: campaign.total_conversions + firstParty.conversions,
        providerConversions: campaign.total_conversions,
        firstPartyConversions: firstParty.conversions,
        conversionValue: firstParty.value,
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

    const firstParty = await adConversionsRepository.getCampaignRollup(campaignId, dateRange);

    return {
      ...result.metrics,
      conversions: result.metrics.conversions + firstParty.conversions,
      providerConversions: result.metrics.conversions,
      firstPartyConversions: firstParty.conversions,
      conversionValue: firstParty.value,
    };
  }

  async getCampaignPerformanceReport(
    campaignId: string,
    organizationId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<CampaignPerformanceReport> {
    const campaign = await adCampaignsRepository.findById(campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    const account = await adAccountsRepository.findById(campaign.ad_account_id);
    if (!account) {
      throw new Error("Ad account not found");
    }

    const metrics = await this.getCampaignMetrics(campaignId, organizationId, dateRange);
    const budgetAmount = parseFloat(campaign.budget_amount);
    const creditsAllocated = parseFloat(campaign.credits_allocated);
    const creditsSpent = parseFloat(campaign.credits_spent);

    return {
      generatedAt: new Date().toISOString(),
      campaign: {
        id: campaign.id,
        name: campaign.name,
        platform: campaign.platform,
        objective: campaign.objective,
        status: campaign.status,
        externalCampaignId: campaign.external_campaign_id,
        appId: campaign.app_id,
        budgetType: campaign.budget_type,
        budgetAmount,
        budgetCurrency: campaign.budget_currency,
        creditsAllocated,
        creditsSpent,
        startDate: campaign.start_date?.toISOString() ?? null,
        endDate: campaign.end_date?.toISOString() ?? null,
        createdAt: campaign.created_at.toISOString(),
        updatedAt: campaign.updated_at.toISOString(),
      },
      dateRange: dateRange
        ? {
            start: dateRange.start.toISOString(),
            end: dateRange.end.toISOString(),
          }
        : null,
      summary: {
        spend: roundMetric(metrics.spend),
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        conversions: metrics.conversions,
        ctr: roundMetric(metrics.ctr ?? safeDiv(metrics.clicks, metrics.impressions, 100)),
        cpc: roundMetric(metrics.cpc ?? safeDiv(metrics.spend, metrics.clicks)),
        cpm: roundMetric(metrics.cpm ?? safeDiv(metrics.spend, metrics.impressions, 1000)),
        conversionRate: roundMetric(safeDiv(metrics.conversions, metrics.clicks, 100)),
        costPerConversion: roundMetric(safeDiv(metrics.spend, metrics.conversions)),
        budgetUtilization: roundMetric(safeDiv(metrics.spend, budgetAmount, 100)),
        conversionValue: roundMetric(metrics.conversionValue ?? 0),
      },
      provider: {
        platform: campaign.platform,
        accountId: campaign.ad_account_id,
        externalAccountId: account.external_account_id,
        externalCampaignId: campaign.external_campaign_id,
      },
    };
  }

  formatCampaignPerformanceCsv(report: CampaignPerformanceReport): string {
    const headers = [
      "campaign_id",
      "campaign_name",
      "platform",
      "status",
      "budget_type",
      "budget_amount",
      "budget_currency",
      "spend",
      "impressions",
      "clicks",
      "conversions",
      "ctr",
      "cpc",
      "cpm",
      "conversion_rate",
      "cost_per_conversion",
      "budget_utilization",
      "conversion_value",
      "date_start",
      "date_end",
      "generated_at",
    ];
    const row = [
      report.campaign.id,
      report.campaign.name,
      report.campaign.platform,
      report.campaign.status,
      report.campaign.budgetType,
      report.campaign.budgetAmount,
      report.campaign.budgetCurrency,
      report.summary.spend,
      report.summary.impressions,
      report.summary.clicks,
      report.summary.conversions,
      report.summary.ctr,
      report.summary.cpc,
      report.summary.cpm,
      report.summary.conversionRate,
      report.summary.costPerConversion,
      report.summary.budgetUtilization,
      report.summary.conversionValue,
      report.dateRange?.start ?? null,
      report.dateRange?.end ?? null,
      report.generatedAt,
    ];
    return `${headers.map(csvCell).join(",")}\n${row.map(csvCell).join(",")}\n`;
  }

  async createCampaignReportShare(
    input: CreateCampaignReportShareInput,
  ): Promise<CampaignReportShare> {
    const campaign = await adCampaignsRepository.findById(input.campaignId);
    if (!campaign || campaign.organization_id !== input.organizationId) {
      throw new Error("Campaign not found");
    }
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new Error("Report share expiration must be in the future");
    }

    const token = randomReportToken();
    const tokenHash = await sha256Hex(token);
    const share = await adReportSharesRepository.create({
      organization_id: input.organizationId,
      campaign_id: input.campaignId,
      token_hash: tokenHash,
      expires_at: input.expiresAt,
      created_by_user_id: input.userId,
    });

    logger.info("[Advertising] Campaign report share created", {
      campaignId: input.campaignId,
      shareId: share.id,
      expiresAt: input.expiresAt.toISOString(),
    });

    return {
      id: share.id,
      campaignId: share.campaign_id,
      token,
      expiresAt: share.expires_at.toISOString(),
      publicPath: `/api/v1/advertising/reports/${encodeURIComponent(token)}`,
    };
  }

  async revokeCampaignReportShare(
    shareId: string,
    organizationId: string,
  ): Promise<{ id: string; status: string; revokedAt: string | null }> {
    const share = await adReportSharesRepository.revoke(shareId, organizationId);
    if (!share) {
      throw new Error("Report share not found");
    }
    return {
      id: share.id,
      status: share.status,
      revokedAt: share.revoked_at?.toISOString() ?? null,
    };
  }

  async getPublicCampaignPerformanceReport(
    token: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<CampaignPerformanceReport> {
    const tokenHash = await sha256Hex(token);
    const share = await adReportSharesRepository.findByTokenHash(tokenHash);
    if (!share || share.status !== "active" || share.expires_at.getTime() <= Date.now()) {
      throw NotFoundError("Report share not found or expired");
    }
    return this.getCampaignPerformanceReport(share.campaign_id, share.organization_id, dateRange);
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

  async getCreative(creativeId: string, organizationId: string): Promise<AdCreative> {
    const creative = await adCreativesRepository.findById(creativeId);
    if (!creative) {
      throw new Error("Creative not found");
    }

    const campaign = await adCampaignsRepository.findById(creative.campaign_id);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Creative not found");
    }

    return creative;
  }

  async createCreative(organizationId: string, input: CreateCreativeInput): Promise<AdCreative> {
    const campaign = await adCampaignsRepository.findById(input.campaignId);
    if (!campaign || campaign.organization_id !== organizationId) {
      throw new Error("Campaign not found");
    }

    const safetyReview = await contentSafetyService.assertSafeForPublicUse({
      surface: "advertising_creative",
      organizationId,
      campaignId: input.campaignId,
      text: this.creativeSafetyText(input),
      imageUrls: this.creativeSafetyImageUrls(input.media),
      metadata: { creativeType: input.type },
    });

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

    let preparedInput = input;
    let account: AdAccount | undefined;
    let credentials: AdAccountCredentials | undefined;
    let provider: AdProvider | undefined;
    if (campaign.external_campaign_id) {
      account = await adAccountsRepository.findById(campaign.ad_account_id);
      if (account) {
        try {
          credentials = await this.getCredentials(account);
          provider = this.getProvider(account.platform);
          const preparedMedia = await this.prepareCreativeMediaForProvider(
            organizationId,
            account,
            provider,
            credentials,
            input,
          );
          preparedInput = { ...input, media: preparedMedia };
        } catch (error) {
          await creditsService.refundCredits({
            organizationId,
            amount: AD_CREDIT_RATES.createCreative,
            description: `Refund: Creative media upload failed - ${
              error instanceof Error ? error.message : String(error)
            }`,
            metadata: { campaignId: input.campaignId, creativeName: input.name },
          });
          throw error;
        }
      }
    }

    // Create creative record
    const creative = await adCreativesRepository.create({
      campaign_id: preparedInput.campaignId,
      name: preparedInput.name,
      type: preparedInput.type,
      headline: preparedInput.headline,
      primary_text: preparedInput.primaryText,
      description: preparedInput.description,
      call_to_action: preparedInput.callToAction,
      destination_url: preparedInput.destinationUrl,
      media: preparedInput.media,
      metadata: {
        facebook_page_id: preparedInput.pageId,
        instagram_account_id: preparedInput.instagramActorId,
        tiktok_identity_id: preparedInput.tiktokIdentityId,
        tiktok_identity_type: preparedInput.tiktokIdentityType,
        content_safety: this.contentSafetyMetadata(safetyReview),
      },
      status: "draft",
    });

    // Sync with platform if campaign is synced
    if (campaign.external_campaign_id) {
      if (account && credentials && provider) {
        const result = await provider.createCreative(
          credentials,
          account.external_account_id,
          campaign.external_campaign_id,
          preparedInput,
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

    const safetyReview = await contentSafetyService.assertSafeForPublicUse({
      surface: "advertising_creative",
      organizationId,
      campaignId: creative.campaign_id,
      creativeId,
      text: this.creativeSafetyText({
        name: input.name ?? creative.name,
        headline: input.headline ?? creative.headline ?? undefined,
        primaryText: input.primaryText ?? creative.primary_text ?? undefined,
        description: input.description ?? creative.description ?? undefined,
        callToAction: input.callToAction ?? creative.call_to_action ?? undefined,
        destinationUrl: input.destinationUrl ?? creative.destination_url ?? undefined,
      }),
      imageUrls: this.creativeSafetyImageUrls(input.media ?? creative.media),
      metadata: { creativeType: input.name ?? creative.name },
    });

    const updated = await adCreativesRepository.update(creativeId, {
      name: input.name,
      headline: input.headline,
      primary_text: input.primaryText,
      description: input.description,
      call_to_action: input.callToAction,
      destination_url: input.destinationUrl,
      media: input.media,
      metadata: {
        ...(creative.metadata ?? {}),
        content_safety: this.contentSafetyMetadata(safetyReview),
      },
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
