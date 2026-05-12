import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { adCampaigns } from "@/db/schemas/ad-campaigns";
import { appUsers } from "@/db/schemas/apps";
import { logger } from "@/lib/utils/logger";

export interface UTMParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface ConversionEvent {
  type: "signup";
  userId: string;
  appId?: string;
  campaignId?: string;
  metadata?: Record<string, unknown>;
}

export interface CampaignAttribution {
  campaignId: string;
  campaignName: string;
  platform: string;
  signups: number;
  conversions: number;
  cost: number;
}

export function parseUTMParams(
  urlOrParams: string | URLSearchParams | Record<string, string>,
): UTMParams {
  let params: URLSearchParams;

  if (typeof urlOrParams === "string") {
    const url = urlOrParams.includes("?")
      ? new URL(urlOrParams, "http://localhost")
      : new URL(`http://localhost?${urlOrParams}`);
    params = url.searchParams;
  } else if (urlOrParams instanceof URLSearchParams) {
    params = urlOrParams;
  } else {
    params = new URLSearchParams(urlOrParams);
  }

  return {
    utm_source: params.get("utm_source") || undefined,
    utm_medium: params.get("utm_medium") || undefined,
    utm_campaign: params.get("utm_campaign") || undefined,
    utm_term: params.get("utm_term") || undefined,
    utm_content: params.get("utm_content") || undefined,
  };
}

export function generateCampaignUrl(
  baseUrl: string,
  campaignId: string,
  platform: string,
  options?: {
    medium?: string;
    content?: string;
    term?: string;
  },
): string {
  const url = new URL(baseUrl);

  url.searchParams.set("utm_source", platform);
  url.searchParams.set("utm_medium", options?.medium || "cpc");
  url.searchParams.set("utm_campaign", campaignId);

  if (options?.content) {
    url.searchParams.set("utm_content", options.content);
  }

  if (options?.term) {
    url.searchParams.set("utm_term", options.term);
  }

  return url.toString();
}

class ConversionTrackingService {
  async trackConversion(event: ConversionEvent): Promise<void> {
    logger.info("[ConversionTracking] Tracking conversion", {
      userId: event.userId,
      campaignId: event.campaignId,
    });

    if (event.campaignId) {
      await dbWrite
        .update(adCampaigns)
        .set({
          total_conversions: sql`${adCampaigns.total_conversions} + 1`,
          updated_at: new Date(),
        })
        .where(eq(adCampaigns.id, event.campaignId));
    }

    // Store attribution data on the app user if applicable
    if (event.appId && event.userId) {
      const [existing] = await dbRead
        .select()
        .from(appUsers)
        .where(and(eq(appUsers.app_id, event.appId), eq(appUsers.user_id, event.userId)))
        .limit(1);

      if (existing) {
        const currentMetadata = (existing.metadata as Record<string, unknown>) || {};
        await dbWrite
          .update(appUsers)
          .set({
            metadata: {
              ...currentMetadata,
              campaign_id: event.campaignId,
              converted_at: new Date().toISOString(),
              ...event.metadata,
            },
            last_seen_at: new Date(),
          })
          .where(eq(appUsers.id, existing.id));
      }
    }
  }

  async trackSignupFromUTM(userId: string, appId: string, utmParams: UTMParams): Promise<void> {
    if (!utmParams.utm_campaign) return;
    const [campaign] = await dbRead
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.id, utmParams.utm_campaign))
      .limit(1);

    if (campaign) {
      await this.trackConversion({
        type: "signup",
        userId,
        appId,
        campaignId: campaign.id,
        metadata: {
          utm_source: utmParams.utm_source,
          utm_medium: utmParams.utm_medium,
          utm_content: utmParams.utm_content,
          utm_term: utmParams.utm_term,
        },
      });
    }
  }

  async getCampaignAttribution(
    organizationId: string,
    options?: { campaignId?: string; appId?: string },
  ): Promise<CampaignAttribution[]> {
    const conditions = [eq(adCampaigns.organization_id, organizationId)];

    if (options?.campaignId) {
      conditions.push(eq(adCampaigns.id, options.campaignId));
    }

    if (options?.appId) {
      conditions.push(eq(adCampaigns.app_id, options.appId));
    }

    const campaigns = await dbRead
      .select()
      .from(adCampaigns)
      .where(and(...conditions))
      .orderBy(desc(adCampaigns.created_at));

    return campaigns.map((campaign) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      platform: campaign.platform,
      signups: campaign.total_conversions,
      conversions: campaign.total_conversions,
      cost: parseFloat(campaign.total_spend),
    }));
  }

  async getUserAttribution(
    userId: string,
    appId: string,
  ): Promise<{
    campaignId?: string;
    campaignName?: string;
    platform?: string;
    utmSource?: string;
    utmMedium?: string;
  } | null> {
    const [appUser] = await dbRead
      .select()
      .from(appUsers)
      .where(and(eq(appUsers.app_id, appId), eq(appUsers.user_id, userId)))
      .limit(1);

    if (!appUser?.metadata) {
      return null;
    }

    const metadata = appUser.metadata as Record<string, unknown>;
    const campaignId = metadata.campaign_id as string | undefined;

    if (!campaignId) {
      return null;
    }

    const [campaign] = await dbRead
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.id, campaignId))
      .limit(1);

    return {
      campaignId,
      campaignName: campaign?.name,
      platform: campaign?.platform,
      utmSource: metadata.utm_source as string | undefined,
      utmMedium: metadata.utm_medium as string | undefined,
    };
  }

  generateCampaignLinks(
    campaignId: string,
    platform: string,
    destinationUrl: string,
    creativeIds: string[],
  ): Record<string, string> {
    return Object.fromEntries(
      creativeIds.map((id) => [
        id,
        generateCampaignUrl(destinationUrl, campaignId, platform, {
          content: id,
        }),
      ]),
    );
  }
}

export const conversionTrackingService = new ConversionTrackingService();
