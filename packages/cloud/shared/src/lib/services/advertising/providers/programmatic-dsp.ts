// Programmatic DSP provider — generic OpenRTB 2.x demand-side platform.
//
// Targets DSPs that expose an OpenRTB 2.x-shaped campaign management REST API:
// advertisers own campaigns, campaigns own line items (the biddable unit that
// carries budget, pricing, and audience/geo targeting), and line items serve
// OpenRTB creatives (Ad objects with `adm` markup, `crid`, `adomain`, IAB
// `cat`). Bidding itself is the OpenRTB wire protocol the DSP speaks to
// exchanges; this adapter drives the management plane the DSP exposes on top.
//
// The DSP base endpoint is configured via the fail-closed `PROGRAMMATIC_DSP_ENDPOINT`
// env var (no default, no placeholder). Per-account auth flows through the
// standard OAuth-style bearer token in `AdAccountCredentials.accessToken`.

import { logger } from "../../../utils/logger";
import { assertSafeAdMediaUrl, mediaFileName } from "../media-utils";
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
  CampaignTargeting,
  CreateCampaignInput,
  CreateCreativeInput,
  UpdateCampaignInput,
  UploadMediaInput,
} from "../types";

// ============================================
// Configuration (fail-closed)
// ============================================

/**
 * Resolves the configured DSP management base URL. Fail-closed: throws if the
 * operator has not provisioned `PROGRAMMATIC_DSP_ENDPOINT`. No default endpoint
 * is assumed — a missing endpoint is a configuration error, not a silent no-op.
 */
function dspBaseUrl(): string {
  const raw = process.env.PROGRAMMATIC_DSP_ENDPOINT?.trim();
  if (!raw) {
    throw new Error(
      "PROGRAMMATIC_DSP_ENDPOINT is not configured; set it to the DSP OpenRTB management API base URL",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PROGRAMMATIC_DSP_ENDPOINT must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("PROGRAMMATIC_DSP_ENDPOINT must use https");
  }
  // Normalize away any trailing slash so path joins are unambiguous.
  return url.toString().replace(/\/+$/, "");
}

/**
 * Optional OpenRTB seat id the DSP buys under. Advertised on line items when
 * the operator provisions it; absence is not an error.
 */
function dspSeatId(): string | undefined {
  const seat = process.env.PROGRAMMATIC_DSP_SEAT_ID?.trim();
  return seat && seat.length > 0 ? seat : undefined;
}

// ============================================
// Wire types (validated at the boundary)
// ============================================

interface DspError {
  message?: string;
  code?: string;
}

interface DspEnvelope<T> {
  data?: T;
  error?: DspError | null;
  message?: string;
}

interface DspAdvertiser {
  id: string;
  name?: string | null;
  currency?: string | null;
}

interface DspEntity {
  id: string;
}

interface DspReportRow {
  spend?: number | string | null;
  impressions?: number | string | null;
  clicks?: number | string | null;
  conversions?: number | string | null;
  conversion_value?: number | string | null;
}

interface DspReport {
  rows?: DspReportRow[];
}

// ============================================
// HTTP
// ============================================

async function dspRequest<T>(
  path: string,
  accessToken: string,
  options: RequestInit & { params?: Record<string, string | undefined> } = {},
): Promise<DspEnvelope<T>> {
  const url = new URL(`${dspBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const { params: _params, ...init } = options;
  const response = await fetch(url.toString(), {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // OpenRTB version the management API creatives conform to.
      "X-OpenRTB-Version": "2.6",
      ...init.headers,
    },
  });

  // An empty body is a legitimate no-content response (e.g. 204 on a PATCH);
  // a non-empty body that will not parse is a transport/protocol failure and
  // must surface, never read as an empty-but-successful envelope (which on the
  // reporting path would fabricate zero spend from a broken fetch).
  const rawBody = await response.text();
  let json: DspEnvelope<T> = {};
  if (rawBody.trim() !== "") {
    try {
      json = JSON.parse(rawBody) as DspEnvelope<T>;
    } catch {
      // error-policy:J3 untrusted DSP response body; a non-JSON payload is invalid input, surfaced (never a fake-empty envelope)
      throw new Error(`DSP API returned a non-JSON body (status ${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(json.error?.message || json.message || `DSP API error: ${response.status}`);
  }
  return json;
}

// ============================================
// Mapping helpers
// ============================================

/**
 * OpenRTB budgets and floors are expressed in whole currency units with up to
 * six-digit precision. We normalize to a fixed micro-unit integer to avoid
 * floating point drift on the wire.
 */
function micros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return 0;
}

/**
 * Maps campaign objective onto the OpenRTB line item optimization goal the DSP
 * bids toward.
 */
function mapObjective(objective: string): string {
  const mapping: Record<string, string> = {
    awareness: "IMPRESSIONS",
    traffic: "CLICKS",
    engagement: "CLICKS",
    leads: "LEADS",
    app_promotion: "INSTALLS",
    sales: "CONVERSIONS",
    conversions: "CONVERSIONS",
  };
  return mapping[objective] || "CLICKS";
}

/**
 * Maps the requested bid strategy onto the OpenRTB pricing model. OpenRTB
 * exchanges settle on a CPM clearing price; CPC/CPA line items are expressed as
 * a goal with a CPM-equivalent bid, which is what the DSP optimizes against.
 */
function mapPricingModel(input: Pick<CreateCampaignInput, "bidStrategy">): string {
  if (input.bidStrategy === "cpc") return "CPC";
  if (input.bidStrategy === "cpa") return "CPA";
  return "CPM";
}

/**
 * Translates the internal targeting DTO into an OpenRTB 2.x targeting object:
 * `geo.country` codes, IAB audience `segment` ids, `sitecat`/placement filters,
 * and content `language`.
 */
function mapTargeting(targeting?: CampaignTargeting): Record<string, unknown> {
  const openrtb: Record<string, unknown> = {};
  if (!targeting) return openrtb;
  if (targeting.locations?.length) openrtb.geo = { country: targeting.locations };
  const segments = [
    ...(targeting.interests ?? []),
    ...(targeting.behaviors ?? []),
    ...(targeting.customAudiences ?? []),
  ];
  if (segments.length) openrtb.segment = segments.map((id) => ({ id }));
  if (targeting.excludedAudiences?.length) {
    openrtb.excluded_segment = targeting.excludedAudiences.map((id) => ({ id }));
  }
  if (targeting.placements?.length) openrtb.sitecat = targeting.placements;
  if (targeting.languages?.length) openrtb.language = targeting.languages;
  const gender = targeting.genders?.find((value) => value !== "all");
  if (gender) openrtb.gender = gender === "male" ? "M" : "F";
  if (targeting.ageMin !== undefined || targeting.ageMax !== undefined) {
    openrtb.yob_range = { min_age: targeting.ageMin, max_age: targeting.ageMax };
  }
  return openrtb;
}

/**
 * The external campaign id is a composite `advertiserId/campaignId/lineItemId`
 * so metrics, updates, and creatives can address the biddable line item without
 * a second round-trip.
 */
function splitExternalId(externalCampaignId: string): {
  advertiserId?: string;
  campaignId: string;
  lineItemId?: string;
} {
  const [advertiserId, campaignId, lineItemId] = externalCampaignId.split("/");
  if (advertiserId && campaignId && lineItemId) return { advertiserId, campaignId, lineItemId };
  if (advertiserId && campaignId) return { advertiserId, campaignId };
  return { campaignId: externalCampaignId };
}

function requireId(envelope: DspEnvelope<DspEntity>, context: string): string {
  const id = envelope.data?.id;
  if (!id) throw new Error(`DSP ${context} returned no id`);
  return id;
}

function summarizeReport(report: DspReport | undefined): CampaignMetrics {
  const rows = report?.rows ?? [];
  const totals = rows.reduce<{
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    conversionValue: number;
  }>(
    (acc, row) => ({
      spend: acc.spend + firstNumber(row.spend),
      impressions: acc.impressions + firstNumber(row.impressions),
      clicks: acc.clicks + firstNumber(row.clicks),
      conversions: acc.conversions + firstNumber(row.conversions),
      conversionValue: acc.conversionValue + firstNumber(row.conversion_value),
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 },
  );
  return {
    spend: totals.spend,
    impressions: totals.impressions,
    clicks: totals.clicks,
    conversions: totals.conversions,
    conversionValue: totals.conversionValue,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0,
    roas: totals.spend > 0 ? totals.conversionValue / totals.spend : 0,
  };
}

/**
 * Builds the OpenRTB creative (`Ad`) markup for a line item. Image media map to
 * a banner Ad (`w`/`h`/`img`), video media to a video Ad (`mimes`), and the
 * click-through lands in `adomain` + the asset `link`.
 */
function buildCreativeAd(input: CreateCreativeInput, seatId: string | undefined) {
  const orderedMedia = [...input.media].sort((a, b) => a.order - b.order);
  const isVideo = input.type === "video" || orderedMedia.some((m) => m.type === "video");
  let adomain: string[] | undefined;
  if (input.destinationUrl) {
    try {
      adomain = [new URL(input.destinationUrl).hostname];
    } catch {
      // error-policy:J3 destinationUrl is untrusted input; a malformed URL yields no adomain (an optional OpenRTB field), never a fabricated one
      adomain = undefined;
    }
  }
  return {
    crid: input.name,
    seat: seatId,
    title: input.headline ?? input.name,
    body: input.primaryText ?? input.description ?? "",
    cta: input.callToAction ?? "learn_more",
    adomain,
    landing_url: input.destinationUrl ?? null,
    format: isVideo ? "video" : "banner",
    assets: orderedMedia.map((media) => ({
      id: media.id,
      type: media.type,
      url: media.url,
      thumbnail_url: media.thumbnailUrl ?? null,
      link: input.destinationUrl ?? null,
    })),
  };
}

// ============================================
// Provider
// ============================================

export const programmaticDspProvider: AdProvider = {
  platform: "programmatic-dsp",

  async validateCredentials(
    credentials: AdAccountCredentials,
  ): Promise<AdProviderValidationResult> {
    let accounts: Array<{ id: string; name: string }>;
    try {
      accounts = await this.listAdAccounts(credentials);
    } catch (err) {
      // error-policy:J4 credential validation reports an explicit invalid state; the real
      // fetch/auth failure is surfaced verbatim, kept distinct from a genuinely empty account list.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[ProgrammaticDsp] Validation failed", { error: message });
      return { valid: false, error: message };
    }
    if (accounts.length === 0) {
      return { valid: false, error: "No DSP advertiser accounts found or invalid credentials" };
    }
    return { valid: true, accountId: accounts[0].id, accountName: accounts[0].name };
  },

  async listAdAccounts(
    credentials: AdAccountCredentials,
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await dspRequest<DspAdvertiser[]>("/advertisers", credentials.accessToken, {
      method: "GET",
      params: { limit: "100" },
    });
    return (response.data ?? []).map((advertiser) => ({
      id: advertiser.id,
      name: advertiser.name || advertiser.id,
    }));
  },

  async createCampaign(
    credentials: AdAccountCredentials,
    accountId: string,
    input: CreateCampaignInput,
  ): Promise<AdProviderCampaignResult> {
    try {
      const budgetType = input.budgetType === "lifetime" ? "LIFETIME" : "DAILY";
      const campaignResponse = await dspRequest<DspEntity>(
        `/advertisers/${encodeURIComponent(accountId)}/campaigns`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            status: "PAUSED",
            objective: mapObjective(input.objective),
            budget_type: budgetType,
            budget_micros: micros(input.budgetAmount),
            currency: input.budgetCurrency ?? "USD",
            flight_start: input.startDate?.toISOString() ?? new Date().toISOString(),
            flight_end: input.endDate?.toISOString() ?? null,
          }),
        },
      );
      const campaignId = requireId(campaignResponse, "campaign create");

      // The OpenRTB line item is the biddable unit: it carries the pricing
      // model, bid floor, and the translated OpenRTB targeting object.
      const lineItemResponse = await dspRequest<DspEntity>(
        `/advertisers/${encodeURIComponent(accountId)}/line-items`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            name: `${input.name} Line Item`,
            campaign_id: campaignId,
            status: "PAUSED",
            seat: dspSeatId(),
            pricing_model: mapPricingModel(input),
            bid_floor_micros: micros(input.budgetAmount),
            targeting: mapTargeting(input.targeting),
          }),
        },
      );
      const lineItemId = requireId(lineItemResponse, "line item create");

      return {
        success: true,
        externalCampaignId: `${accountId}/${campaignId}/${lineItemId}`,
      };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the failed create into a structured failure result
      logger.error("[ProgrammaticDsp] Campaign creation failed", {
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
      const { campaignId, lineItemId } = splitExternalId(externalCampaignId);
      const campaignPatch: Record<string, unknown> = {};
      if (input.name) campaignPatch.name = input.name;
      if (input.startDate) campaignPatch.flight_start = input.startDate.toISOString();
      if (input.endDate !== undefined) {
        campaignPatch.flight_end = input.endDate?.toISOString() ?? null;
      }
      if (input.budgetAmount !== undefined) {
        campaignPatch.budget_micros = micros(input.budgetAmount);
      }
      if (Object.keys(campaignPatch).length > 0) {
        await dspRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
          method: "PATCH",
          body: JSON.stringify(campaignPatch),
        });
      }

      const lineItemPatch: Record<string, unknown> = {};
      if (input.bidStrategy) lineItemPatch.pricing_model = mapPricingModel(input);
      if (input.budgetAmount !== undefined) {
        lineItemPatch.bid_floor_micros = micros(input.budgetAmount);
      }
      if (input.targeting) lineItemPatch.targeting = mapTargeting(input.targeting);
      if (lineItemId && Object.keys(lineItemPatch).length > 0) {
        await dspRequest(`/line-items/${encodeURIComponent(lineItemId)}`, credentials.accessToken, {
          method: "PATCH",
          body: JSON.stringify(lineItemPatch),
        });
      }
      return { success: true, externalCampaignId };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the failed update into a structured failure result
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async pauseCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    return setCampaignStatus(credentials, externalCampaignId, "PAUSED");
  },

  async activateCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<AdProviderCampaignResult> {
    return setCampaignStatus(credentials, externalCampaignId, "ACTIVE");
  },

  async deleteCampaign(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { campaignId, lineItemId } = splitExternalId(externalCampaignId);
    try {
      if (lineItemId) {
        await dspRequest(`/line-items/${encodeURIComponent(lineItemId)}`, credentials.accessToken, {
          method: "PATCH",
          body: JSON.stringify({ status: "ARCHIVED" }),
        });
      }
      await dspRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ status: "ARCHIVED" }),
      });
      return { success: true };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the failed delete into a structured failure result
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
      const { lineItemId } = splitExternalId(externalCampaignId);
      if (!lineItemId) {
        throw new Error("DSP creative requires a composite advertiser/campaign/line-item id");
      }
      const ad = buildCreativeAd(input, dspSeatId());
      const creativeResponse = await dspRequest<DspEntity>(
        `/advertisers/${encodeURIComponent(accountId)}/creatives`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({ name: input.name, status: "PENDING_REVIEW", ad }),
        },
      );
      const creativeId = requireId(creativeResponse, "creative create");

      const associationResponse = await dspRequest<DspEntity>(
        `/line-items/${encodeURIComponent(lineItemId)}/creatives`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({ creative_id: creativeId, status: "PAUSED" }),
        },
      );
      const associationId = requireId(associationResponse, "creative association");
      return { success: true, externalCreativeId: `${creativeId}/${associationId}` };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the failed creative create into a structured failure result
      logger.error("[ProgrammaticDsp] Creative creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async uploadMedia(
    _credentials: AdAccountCredentials,
    _accountId: string,
    input: UploadMediaInput,
  ): Promise<AdProviderMediaUploadResult> {
    // OpenRTB creatives reference asset URLs directly; we return a stable,
    // SSRF-checked handle so creatives can be retried without re-uploading.
    try {
      await assertSafeAdMediaUrl(input.url);
      const id = `dsp-url:${mediaFileName({ name: input.name, url: input.url })}`;
      return {
        success: true,
        providerAssetId: id,
        providerAssetUrl: input.url,
        providerAssetResourceName: input.url,
        metadata: { storage: "external_url", type: input.type },
      };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the SSRF/validation failure into a structured failure result
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getMediaStatus(
    _credentials: AdAccountCredentials,
    _accountId: string,
    input: { providerAssetResourceName: string },
  ): Promise<AdProviderMediaStatusResult> {
    return {
      success: true,
      providerAssetId: input.providerAssetResourceName,
      providerAssetUrl: input.providerAssetResourceName,
      providerAssetResourceName: input.providerAssetResourceName,
      status: "AVAILABLE",
      ready: true,
    };
  },

  async getCampaignMetrics(
    credentials: AdAccountCredentials,
    externalCampaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<AdProviderMetricsResult> {
    const { advertiserId, campaignId } = splitExternalId(externalCampaignId);
    try {
      if (!advertiserId) {
        throw new Error("DSP metrics require a composite advertiser/campaign id");
      }
      const end = dateRange?.end ?? new Date();
      const start = dateRange?.start ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const response = await dspRequest<DspReport>(
        `/advertisers/${encodeURIComponent(advertiserId)}/reports`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            start_date: start.toISOString(),
            end_date: end.toISOString(),
            group_by: ["campaign_id"],
            metrics: ["spend", "impressions", "clicks", "conversions", "conversion_value"],
            filter: { campaign_id: campaignId },
          }),
        },
      );
      return { success: true, metrics: summarizeReport(response.data) };
    } catch (error) {
      // error-policy:J1 AdProvider boundary translates the failed report fetch into a structured failure result (distinct from a legitimately empty report, which returns success with zeroed metrics)
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

async function setCampaignStatus(
  credentials: AdAccountCredentials,
  externalCampaignId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<AdProviderCampaignResult> {
  const { campaignId, lineItemId } = splitExternalId(externalCampaignId);
  try {
    await dspRequest(`/campaigns/${encodeURIComponent(campaignId)}`, credentials.accessToken, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    if (lineItemId) {
      await dspRequest(`/line-items/${encodeURIComponent(lineItemId)}`, credentials.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    }
    return { success: true, externalCampaignId };
  } catch (error) {
    // error-policy:J1 AdProvider boundary translates the failed status patch into a structured failure result
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
