/**
 * User MCPs Service
 *
 * Manages user-created MCP servers with monetization support.
 * Handles CRUD, revenue distribution, and discovery.
 */

import { ElizaError } from "@elizaos/core";
import {
  formatOrganizationCreditUsd,
  legacyMcpPointsToOrganizationCredits,
  type McpUsageChargeReceipt,
  mcpUsageChargeReceiptFromLegacyPoints,
  ORGANIZATION_CREDIT_UNIT,
  organizationCreditsToLegacyMcpPoints,
} from "../../billing/organization-credits";
import { mcpUsageRepository, type UserMcp, userMcpsRepository } from "../../db/repositories";
import { mcpSettlementsRepository } from "../../db/repositories/mcp-settlements";
import type { McpSettlement } from "../../db/schemas/mcp-settlements";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { assertSafeOutboundUrlSync } from "../security/outbound-url";
import { logger } from "../utils/logger";
import { containersService } from "./containers";
import { creditsService } from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";

// ============================================================================
// Types
// ============================================================================

export interface CreateMcpParams {
  name: string;
  slug: string;
  description: string;
  organizationId: string;
  userId: string;
  category?: string;
  endpointType?: "container" | "external";
  containerId?: string;
  externalEndpoint?: string;
  endpointPath?: string;
  transportType?: "streamable-http" | "stdio";
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    cost?: string;
  }>;
  pricingType?: "free" | "credits" | "x402";
  /** Canonical price in USD-denominated organization cloud credits. */
  priceUsd?: number;
  /** @deprecated Legacy MCP pricing points (100 points = $1). */
  creditsPerRequest?: number;
  x402PriceUsd?: number;
  x402Enabled?: boolean;
  creatorSharePercentage?: number;
  documentationUrl?: string;
  sourceCodeUrl?: string;
  supportEmail?: string;
  tags?: string[];
  icon?: string;
  color?: string;
}

export interface UpdateMcpParams {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  endpointPath?: string;
  transportType?: "streamable-http" | "stdio";
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    cost?: string;
  }>;
  pricingType?: "free" | "credits" | "x402";
  /** Canonical price in USD-denominated organization cloud credits. */
  priceUsd?: number;
  /** @deprecated Legacy MCP pricing points (100 points = $1). */
  creditsPerRequest?: number;
  x402PriceUsd?: number;
  x402Enabled?: boolean;
  creatorSharePercentage?: number;
  documentationUrl?: string | null;
  sourceCodeUrl?: string | null;
  supportEmail?: string | null;
  tags?: string[];
  icon?: string;
  color?: string;
  isPublic?: boolean;
}

export interface UseMcpParams {
  mcpId: string;
  organizationId: string;
  userId?: string;
  toolName: string;
  paymentType: "credits" | "x402";
  metadata?: Record<string, unknown>;
}

export interface UseMcpWithoutDeductionParams {
  mcpId: string;
  organizationId: string;
  userId?: string;
  toolName: string;
  creditsCharged: number;
  affiliateFeeCredits?: number;
  platformFeeCredits?: number;
  /** Exact canonical receipt used by the caller's completed precharge. */
  chargeReceipt?: McpUsageChargeReceipt;
  affiliateOwnerId?: string;
  affiliateCodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface UseMcpResult {
  success: boolean;
  /** @deprecated Legacy MCP pricing points (100 points = $1). */
  creditsCharged: number;
  /** Canonical base price; excludes affiliate and platform surcharges. */
  basePriceUsd: number;
  affiliateFeeUsd: number;
  platformFeeUsd: number;
  totalPriceUsd: number;
  creditUnit: typeof ORGANIZATION_CREDIT_UNIT;
  x402AmountUsd: number;
  creatorEarnings: number;
  /** Authority receipt id linking the buyer debit to every payout leg. */
  settlementId: string;
  platformEarnings: number;
  usageId: string;
}

export type PublicUserMcp = Omit<UserMcp, "external_endpoint" | "created_by_user_id"> & {
  external_endpoint: null;
  created_by_user_id: null;
};

export type ApiUserMcp = (UserMcp | PublicUserMcp) & {
  /** Canonical external denomination. One organization cloud credit is $1 USD. */
  credit_unit: typeof ORGANIZATION_CREDIT_UNIT;
  /**
   * Canonical per-request price for every pricing mode, or `null` when the
   * stored price column is unusable. `price_available` discriminates the two;
   * a corrupt row must never render as a healthy `"0"`.
   */
  price_usd: string | null;
  /** False when the stored price could not be read for this row. */
  price_available: boolean;
  /** Explicit compatibility mirror of the historical cent-like storage field. */
  legacy_credits_per_request: string | null;
  /**
   * Canonical creator revenue represented by the legacy earned-points total,
   * or `null` when the stored earnings total is unusable.
   */
  total_creator_revenue_usd: string | null;
};

// ============================================================================
// Money-path NUMERIC fail-closed boundary (#13415)
// ============================================================================

/**
 * Raised when a monetization NUMERIC column read from the DB is corrupt.
 *
 * Postgres NUMERIC columns are returned by the driver as strings, and
 * `'NaN'::numeric` is a VALID stored value that reads back as the literal
 * `"NaN"`. A bare `Number("NaN")` yields `NaN`, and every downstream money
 * gate in `recordUsage` (`totalCreditsToDeduct > 0`, `creatorEarnings > 0`,
 * `affiliateFeeCredits > 0`) is FALSE for `NaN`, so a corrupt price/share row
 * silently: (a) skips charging the consumer while still executing the tool
 * call = free MCP usage, and (b) writes `"NaN"` into the usage/earnings ledger.
 * We fail closed at read time so the whole MCP call is refused before any
 * charge/credit/earnings side-effect runs.
 */
export class CorruptMcpBillingNumberError extends ElizaError {
  override readonly name = "CorruptMcpBillingNumberError";

  constructor(field: string, rawValue: unknown, bounds: { min?: number; max?: number } = {}) {
    super(`[UserMcps] corrupt MCP billing value for ${field}: ${JSON.stringify(rawValue)}`, {
      code: "CORRUPT_MCP_BILLING_NUMBER",
      context: { field, rawValue, ...bounds },
      severity: "fatal",
    });
  }
}

/**
 * Parse a monetization NUMERIC value fail-closed.
 *
 * - `null`/`undefined` are treated as the DB default absence and resolve to
 *   `fallback` (the nullable price columns `credits_per_request` /
 *   `x402_price_usd` default via the caller; `Number(null)` used to be `0`).
 * - Any present-but-non-finite value (`"NaN"`, `"Infinity"`, `""`, garbage)
 *   THROWS, it must never become `NaN` in the money math.
 * - Money values are bounded at this boundary so a negative stored price/share
 *   cannot skip charge gates and write negative ledger rows.
 *
 * `Number()` (not `parseFloat`) so a mangled `"1.0garbage"` rejects instead of
 * being silently truncated to `1`.
 */
function parseMcpBillingNumber(
  value: string | number | null | undefined,
  field: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (value === null || value === undefined) {
    return parseMcpBillingNumber(fallback, field, fallback, options);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    (options.min !== undefined && parsed < options.min) ||
    (options.max !== undefined && parsed > options.max)
  ) {
    throw new CorruptMcpBillingNumberError(field, value, options);
  }
  return parsed;
}

function parseNonNegativeMcpBillingNumber(
  value: string | number | null | undefined,
  field: string,
  fallback: number,
): number {
  return parseMcpBillingNumber(value, field, fallback, { min: 0 });
}

/**
 * The buyer-debit FK slot takes a uuid; the canonical settlement identity is
 * the textual payment_event_id, which for synthesized or non-uuid provider
 * events is not a uuid. Store the FK only when the id really is one.
 */
function uuidOrNull(value: string): string | null {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function parseMcpSharePercentage(
  value: string | number | null | undefined,
  field: string,
  fallback: number,
): number {
  return parseMcpBillingNumber(value, field, fallback, { min: 0, max: 100 });
}

/**
 * Raised when a stored MCP row cannot settle on the requested payment rail:
 * the receipt's CHECK constraints (`mcp_settlements_x402_check`) require a
 * strictly positive amount on the x402 rail, so a zero or absent
 * `x402_price_usd` must be refused BEFORE delivery — the alternative is a raw
 * Postgres CHECK violation surfacing out of `claim()` after the tool call has
 * already run, with no receipt, no usage row, no creator payout, and no
 * recovery path (#22961, #27992 review).
 */
export class UnsettleableMcpRowError extends ElizaError {
  override readonly name = "UnsettleableMcpRowError";

  constructor(field: string, rawValue: unknown, rail: "credits" | "x402") {
    super(
      `[UserMcps] ${rail} settlement requires a positive ${field}: ${JSON.stringify(rawValue)}`,
      {
        code: "MCP_ROW_UNSETTLEABLE",
        context: { field, rawValue, rail },
        severity: "fatal",
      },
    );
  }
}

/**
 * Fail-closed precharge gate for a stored MCP row (#22961): every NUMERIC the
 * settlement math will read is validated BEFORE the buyer is debited, so a
 * corrupt row refuses the call instead of debiting and then throwing mid
 * settlement (which would orphan the debit). Shared by `recordUsage` and the
 * MCP proxy's precharge boundary.
 *
 * On the x402 rail the gate is also a rail-shape refusal: the receipt CHECK
 * demands `x402_amount_usd > 0` for `payment_type = 'x402'`, and the only
 * source for that amount is `x402_price_usd` — so a zero or absent price
 * throws here rather than dying in the database post-delivery (#27992).
 */
export function assertSettleableMcpRow(
  mcp: {
    credits_per_request?: string | null;
    x402_price_usd?: string | null;
    creator_share_percentage?: string | null;
    platform_share_percentage?: string | null;
  },
  options: { paymentType: "credits" | "x402" },
): void {
  parseNonNegativeMcpBillingNumber(mcp.credits_per_request, "credits_per_request", 0);
  const x402PriceUsd = parseNonNegativeMcpBillingNumber(mcp.x402_price_usd, "x402_price_usd", 0);
  parseMcpSharePercentage(mcp.creator_share_percentage, "creator_share_percentage", 0);
  parseMcpSharePercentage(mcp.platform_share_percentage, "platform_share_percentage", 0);
  if (options.paymentType === "x402" && x402PriceUsd <= 0) {
    throw new UnsettleableMcpRowError("x402_price_usd", mcp.x402_price_usd, "x402");
  }
}

function resolveStoredMcpPricePoints(params: {
  priceUsd?: number;
  legacyCreditsPerRequest?: number;
  fallback?: number;
}): number | undefined {
  const canonicalPrice =
    params.priceUsd === undefined
      ? undefined
      : parseNonNegativeMcpBillingNumber(params.priceUsd, "priceUsd", 0);
  const legacyPrice =
    params.legacyCreditsPerRequest === undefined
      ? undefined
      : parseNonNegativeMcpBillingNumber(params.legacyCreditsPerRequest, "creditsPerRequest", 0);
  const convertedCanonical =
    canonicalPrice === undefined ? undefined : organizationCreditsToLegacyMcpPoints(canonicalPrice);

  if (
    convertedCanonical !== undefined &&
    legacyPrice !== undefined &&
    Math.abs(convertedCanonical - legacyPrice) > 1e-9
  ) {
    throw new ElizaError(
      "priceUsd and deprecated creditsPerRequest describe different MCP prices",
      {
        code: "MCP_PRICE_UNIT_CONFLICT",
        context: {
          priceUsd: canonicalPrice,
          creditsPerRequest: legacyPrice,
        },
        severity: "ephemeral",
      },
    );
  }

  return convertedCanonical ?? legacyPrice ?? params.fallback;
}

/** Presentation price for one stored MCP row, or an explicit unavailable price. */
export type CanonicalMcpPrice =
  | { priceAvailable: true; priceUsd: string }
  | { priceAvailable: false; priceUsd: null };

const UNAVAILABLE_MCP_PRICE: CanonicalMcpPrice = Object.freeze({
  priceAvailable: false,
  priceUsd: null,
});

function renderCanonicalMcpPriceUsd(mcp: UserMcp | PublicUserMcp): string {
  if (mcp.pricing_type === "credits") {
    const legacyPoints = parseNonNegativeMcpBillingNumber(
      mcp.credits_per_request,
      "credits_per_request",
      0,
    );
    return formatOrganizationCreditUsd(legacyMcpPointsToOrganizationCredits(legacyPoints));
  }
  if (mcp.pricing_type === "x402") {
    // x402 prices are already stored as USD and may be finer than the
    // cloud-credit grid, so they are passed through without quantization.
    return parseNonNegativeMcpBillingNumber(mcp.x402_price_usd, "x402_price_usd", 0).toString();
  }
  return "0";
}

/**
 * Resolve the stored price as canonical cloud-credit USD. Quantizing here is
 * what keeps a fractional legacy point value such as `1.1` from serializing as
 * `0.011000000000000001` into the API, registry, and public description.
 *
 * This is a presentation boundary, not a charge boundary: `toApiMcp` runs once
 * per row of the owner listing and once for the anonymous proxy-info endpoint,
 * so a single corrupt price column must degrade to an explicit unavailable
 * price rather than fail the whole response. The charge path keeps its
 * fail-closed read in `recordUsage`. This matches the discovery price boundary
 * in `packages/cloud/api/v1/discovery/pricing.ts`.
 */
function resolveCanonicalMcpPrice(mcp: UserMcp | PublicUserMcp): CanonicalMcpPrice {
  try {
    return { priceAvailable: true, priceUsd: renderCanonicalMcpPriceUsd(mcp) };
  } catch (error) {
    // error-policy:J3 untrusted stored price; one corrupt row becomes an
    // explicit unavailable price instead of a fake $0 or a failed listing.
    logger.warn("[UserMcps] unusable stored MCP price", {
      mcpId: mcp.id,
      pricingType: mcp.pricing_type,
      creditsPerRequest: String(mcp.credits_per_request),
      x402PriceUsd: String(mcp.x402_price_usd),
      error: error instanceof Error ? error.message : String(error),
    });
    return UNAVAILABLE_MCP_PRICE;
  }
}

/**
 * The x402 rail amount recorded on the usage row: the provider-payment USD
 * that funded the purchase, read from the receipt snapshot so recovery never
 * re-derives it from mutable mcp row state.
 */
function x402RailAmount(settlement: McpSettlement): number {
  return settlement.payment_type === "x402" ? Number(settlement.x402_amount_usd) : 0;
}

/**
 * Render lifetime creator revenue for a listed row, or `null` when the stored
 * earnings total is unusable. Same listing-wide blast radius as the price
 * column, so it degrades the same way instead of failing the response.
 */
function resolveCreatorRevenueUsd(mcp: UserMcp | PublicUserMcp): string | null {
  try {
    return formatOrganizationCreditUsd(
      legacyMcpPointsToOrganizationCredits(
        parseNonNegativeMcpBillingNumber(mcp.total_credits_earned, "total_credits_earned", 0),
      ),
    );
  } catch (error) {
    // error-policy:J3 untrusted stored earnings total; the row reports an
    // explicit unavailable revenue instead of a fake $0 or a failed listing.
    logger.warn("[UserMcps] unusable stored MCP earnings total", {
      mcpId: mcp.id,
      totalCreditsEarned: String(mcp.total_credits_earned),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// Service
// ============================================================================

class UserMcpsService {
  /**
   * Invalidate cache for an MCP
   */
  async invalidateCache(mcp: UserMcp): Promise<void> {
    const promises = [
      cache.del(CacheKeys.mcp.byId(mcp.id)),
      cache.del(CacheKeys.mcp.bySlug(mcp.organization_id, mcp.slug)),
    ];
    await Promise.all(promises);
    logger.debug("[UserMcps] Invalidated cache for MCP:", mcp.id);
  }

  /**
   * Create a new user MCP
   */
  async create(params: CreateMcpParams): Promise<UserMcp> {
    // Validate container exists if using container endpoint
    if (params.endpointType === "container" && params.containerId) {
      const container = await containersService.getById(params.containerId, params.organizationId);
      if (!container) {
        throw new Error("Container not found");
      }
      if (container.organization_id !== params.organizationId) {
        throw new Error("Container does not belong to this organization");
      }
    }

    if (params.endpointType === "external" && params.externalEndpoint) {
      // Synchronous-only guard at registration (no DNS): a momentarily
      // unresolvable host must not 500 a write. Full DNS-based SSRF enforcement
      // runs at fetch time in mcp/proxy/[mcpId] via assertSafeOutboundUrl.
      assertSafeOutboundUrlSync(params.externalEndpoint);
    }

    // Check slug uniqueness
    const existing = await userMcpsRepository.getBySlug(params.slug, params.organizationId);
    if (existing) {
      throw new Error(`MCP with slug "${params.slug}" already exists`);
    }

    const creatorSharePercentage = parseMcpSharePercentage(
      params.creatorSharePercentage,
      "creatorSharePercentage",
      80,
    );

    const mcp = await userMcpsRepository.create({
      name: params.name,
      slug: params.slug,
      description: params.description,
      organization_id: params.organizationId,
      created_by_user_id: params.userId,
      category: params.category ?? "utilities",
      endpoint_type: params.endpointType ?? "container",
      container_id: params.containerId,
      external_endpoint: params.externalEndpoint,
      endpoint_path: params.endpointPath ?? "/mcp",
      transport_type: params.transportType ?? "streamable-http",
      tools: params.tools ?? [],
      pricing_type: params.pricingType ?? "credits",
      credits_per_request: resolveStoredMcpPricePoints({
        priceUsd: params.priceUsd,
        legacyCreditsPerRequest: params.creditsPerRequest,
        fallback: 1,
      })?.toString(),
      x402_price_usd: parseNonNegativeMcpBillingNumber(
        params.x402PriceUsd,
        "x402PriceUsd",
        0.0001,
      ).toString(),
      x402_enabled: params.x402Enabled ?? false,
      creator_share_percentage: creatorSharePercentage.toString(),
      platform_share_percentage: (100 - creatorSharePercentage).toString(),
      documentation_url: params.documentationUrl,
      source_code_url: params.sourceCodeUrl,
      support_email: params.supportEmail,
      tags: params.tags ?? [],
      icon: params.icon ?? "puzzle",
      color: params.color ?? "#6366F1",
      status: "draft",
      is_public: true,
    });

    logger.info("[UserMcps] Created MCP", {
      id: mcp.id,
      name: mcp.name,
      slug: mcp.slug,
    });

    return mcp;
  }

  /**
   * Get MCP by ID
   */
  async getById(id: string): Promise<UserMcp | null> {
    const cacheKey = CacheKeys.mcp.byId(id);
    const cached = await cache.get<UserMcp>(cacheKey);
    if (cached) return cached;

    const mcp = await userMcpsRepository.getById(id);
    if (mcp) {
      await cache.set(cacheKey, mcp, CacheTTL.mcp.data);
    }
    return mcp;
  }

  /**
   * Get MCP by slug and organization
   */
  async getBySlug(slug: string, organizationId: string): Promise<UserMcp | null> {
    const cacheKey = CacheKeys.mcp.bySlug(organizationId, slug);
    const cached = await cache.get<UserMcp>(cacheKey);
    if (cached) return cached;

    const mcp = await userMcpsRepository.getBySlug(slug, organizationId);
    if (mcp) {
      await cache.set(cacheKey, mcp, CacheTTL.mcp.data);
    }
    return mcp;
  }

  /**
   * List MCPs by organization
   */
  async listByOrganization(
    organizationId: string,
    options?: {
      status?: UserMcp["status"];
      limit?: number;
      offset?: number;
    },
  ): Promise<UserMcp[]> {
    return userMcpsRepository.listByOrganization(organizationId, options);
  }

  /**
   * List public MCPs (for registry)
   */
  async listPublic(options?: {
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
    orderBy?: "name";
  }): Promise<UserMcp[]> {
    return userMcpsRepository.listPublic({ ...options, status: "live" });
  }

  async countPublic(options?: { search?: string; category?: string }): Promise<number> {
    return userMcpsRepository.countPublic({ ...options, status: "live" });
  }

  /**
   * Update an MCP
   */
  async update(id: string, organizationId: string, params: UpdateMcpParams): Promise<UserMcp> {
    const mcp = await userMcpsRepository.getById(id);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    if (mcp.organization_id !== organizationId) {
      throw new Error("Unauthorized");
    }

    const updateData: Partial<UserMcp> = {};

    if (params.name !== undefined) updateData.name = params.name;
    if (params.description !== undefined) updateData.description = params.description;
    if (params.version !== undefined) updateData.version = params.version;
    if (params.category !== undefined) updateData.category = params.category;
    if (params.endpointPath !== undefined) updateData.endpoint_path = params.endpointPath;
    if (params.transportType !== undefined) updateData.transport_type = params.transportType;
    if (params.tools !== undefined) updateData.tools = params.tools;
    if (params.pricingType !== undefined) updateData.pricing_type = params.pricingType;
    if (params.priceUsd !== undefined || params.creditsPerRequest !== undefined) {
      updateData.credits_per_request = resolveStoredMcpPricePoints({
        priceUsd: params.priceUsd,
        legacyCreditsPerRequest: params.creditsPerRequest,
      })?.toString();
    }
    if (params.x402PriceUsd !== undefined) {
      updateData.x402_price_usd = parseNonNegativeMcpBillingNumber(
        params.x402PriceUsd,
        "x402PriceUsd",
        0.0001,
      ).toString();
    }
    if (params.x402Enabled !== undefined) updateData.x402_enabled = params.x402Enabled;
    if (params.creatorSharePercentage !== undefined) {
      const creatorSharePercentage = parseMcpSharePercentage(
        params.creatorSharePercentage,
        "creatorSharePercentage",
        80,
      );
      updateData.creator_share_percentage = creatorSharePercentage.toString();
      updateData.platform_share_percentage = (100 - creatorSharePercentage).toString();
    }
    if (params.documentationUrl !== undefined)
      updateData.documentation_url = params.documentationUrl;
    if (params.sourceCodeUrl !== undefined) updateData.source_code_url = params.sourceCodeUrl;
    if (params.supportEmail !== undefined) updateData.support_email = params.supportEmail;
    if (params.tags !== undefined) updateData.tags = params.tags;
    if (params.icon !== undefined) updateData.icon = params.icon;
    if (params.color !== undefined) updateData.color = params.color;
    if (params.isPublic !== undefined) updateData.is_public = params.isPublic;

    const updated = await userMcpsRepository.update(id, updateData);
    if (!updated) {
      throw new Error("Failed to update MCP");
    }

    await this.invalidateCache(updated);

    logger.info("[UserMcps] Updated MCP", { id, updates: Object.keys(params) });

    return updated;
  }

  /**
   * Publish an MCP (make it live)
   */
  async publish(id: string, organizationId: string): Promise<UserMcp> {
    const mcp = await userMcpsRepository.getById(id);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    if (mcp.organization_id !== organizationId) {
      throw new Error("Unauthorized");
    }

    // Validate MCP is ready to publish
    if (!mcp.name || !mcp.description) {
      throw new Error("MCP must have a name and description");
    }
    if (mcp.tools.length === 0) {
      throw new Error("MCP must have at least one tool defined");
    }
    if (mcp.endpoint_type === "container" && !mcp.container_id) {
      throw new Error("Container MCP must have a container assigned");
    }
    if (mcp.endpoint_type === "external" && !mcp.external_endpoint) {
      throw new Error("External MCP must have an endpoint URL");
    }
    if (mcp.endpoint_type === "external" && mcp.external_endpoint) {
      // Synchronous-only guard (no DNS), see create(). DNS SSRF runs at fetch.
      assertSafeOutboundUrlSync(mcp.external_endpoint);
    }

    const updated = await userMcpsRepository.updateStatus(id, "live");
    if (!updated) {
      throw new Error("Failed to publish MCP");
    }

    await this.invalidateCache(updated);

    logger.info("[UserMcps] Published MCP", {
      id,
      name: mcp.name,
    });

    return updated;
  }

  /**
   * Unpublish an MCP
   */
  async unpublish(id: string, organizationId: string): Promise<UserMcp> {
    const mcp = await userMcpsRepository.getById(id);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    if (mcp.organization_id !== organizationId) {
      throw new Error("Unauthorized");
    }

    const updated = await userMcpsRepository.updateStatus(id, "draft");
    if (!updated) {
      throw new Error("Failed to unpublish MCP");
    }

    await this.invalidateCache(updated);

    logger.info("[UserMcps] Unpublished MCP", { id });

    return updated;
  }

  /**
   * Delete an MCP
   */
  async delete(id: string, organizationId: string): Promise<void> {
    const mcp = await userMcpsRepository.getById(id);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    if (mcp.organization_id !== organizationId) {
      throw new Error("Unauthorized");
    }

    await userMcpsRepository.delete(id);
    await this.invalidateCache(mcp);

    logger.info("[UserMcps] Deleted MCP", { id });
  }

  /**
   * Record a zero-cost MCP usage event from the proxy's free tier (#22961).
   *
   * Structural zero-cost guarantee: unlike `recordUsage`, this path never
   * re-reads the mutable MCP price row after the proxied call and can never
   * debit the buyer or claim a settlement — a price change landing between
   * the route's pre-dispatch snapshot and usage recording cannot turn a free
   * call into a post-delivery charge. Earnings stats are recorded at 0.
   */
  async recordZeroCostUsage(params: {
    mcpId: string;
    organizationId: string;
    userId: string;
    toolName: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const mcp = await userMcpsRepository.getById(params.mcpId);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    await mcpUsageRepository.createWithStats(
      {
        mcp_id: mcp.id,
        organization_id: params.organizationId,
        user_id: params.userId,
        tool_name: params.toolName,
        request_count: 1,
        credits_charged: (0).toString(),
        base_amount_usd: (0).toFixed(6),
        affiliate_fee_usd: (0).toFixed(6),
        platform_fee_usd: (0).toFixed(6),
        total_amount_usd: (0).toFixed(6),
        fee_components_known: true,
        x402_amount_usd: (0).toString(),
        payment_type: "credits",
        creator_earnings: (0).toString(),
        platform_earnings: (0).toString(),
        metadata: {
          input: undefined,
          responseTime:
            typeof params.metadata?.responseTime === "number"
              ? params.metadata.responseTime
              : undefined,
          success: true,
        },
      },
      { mcpId: mcp.id, creatorEarnings: 0, x402EarnedUsd: 0 },
    );
  }

  /**
   * Record MCP usage and distribute revenue
   */
  async recordUsage(params: UseMcpParams): Promise<UseMcpResult> {
    const mcp = await userMcpsRepository.getById(params.mcpId);
    if (!mcp) {
      throw new Error("MCP not found");
    }

    // Calculate charges and revenue split
    let creditsCharged = 0;
    let x402AmountUsd = 0;

    // Fail closed on corrupt price rows BEFORE any charge/credit/earnings runs:
    // a NaN price would slip past the `totalCreditsToDeduct > 0` charge gate
    // (NaN > 0 === false) yet still execute the tool call for free and write
    // "NaN" into the ledger.
    if (params.paymentType === "credits") {
      creditsCharged = parseNonNegativeMcpBillingNumber(
        mcp.credits_per_request,
        "credits_per_request",
        0,
      );
    } else {
      x402AmountUsd = parseNonNegativeMcpBillingNumber(mcp.x402_price_usd, "x402_price_usd", 0);
      // Convert to credits using configured rate
      creditsCharged = organizationCreditsToLegacyMcpPoints(x402AmountUsd);
    }

    // WHY affiliate fee on top of creditsCharged: Customer pays base + affiliate% + platform%;
    // we pay affiliate from that. Referral splits are not used for MCP, keeps one payout
    // type per transaction so we never over-allocate.
    let affiliateFeeCredits = 0;
    let platformFeeCredits = 0;
    let affiliateOwnerId: string | null = null;
    let affiliateCodeId: string | null = null;

    if (params.userId) {
      // The affiliate lookup participates in the money path. If it is unavailable,
      // fail before charging so the transaction cannot silently drop owed fees.
      const { affiliatesService } = await import("./affiliates");
      const referrer = await affiliatesService.getReferrer(params.userId);
      if (referrer) {
        affiliateOwnerId = referrer.user_id;
        affiliateCodeId = referrer.id;
        const affiliatePercent = parseMcpSharePercentage(
          referrer.markup_percent,
          "markup_percent",
          0,
        );
        const platformPercent = 20.0;

        affiliateFeeCredits = creditsCharged * (affiliatePercent / 100);
        platformFeeCredits = creditsCharged * (platformPercent / 100);
      }
    }

    const totalCreditsToDeduct = creditsCharged + affiliateFeeCredits + platformFeeCredits;
    const chargeReceipt = mcpUsageChargeReceiptFromLegacyPoints({
      basePoints: creditsCharged,
      affiliateFeePoints: affiliateFeeCredits,
      platformFeePoints: platformFeeCredits,
    });

    // Fail closed on corrupt share rows BEFORE the buyer is debited: the
    // settlement math re-reads them after the charge, and a throw there would
    // orphan the debit with no settlement row to key its recovery (#22961,
    // preserving the #13415 pre-charge contract).
    assertSettleableMcpRow(mcp, { paymentType: params.paymentType });

    // Charge the consumer. The debit transaction IS the payment event: its id
    // keys the settlement authority so a retry of this call can never
    // double-charge or double-distribute (#22961).
    let paymentEventId = "";
    if (params.paymentType === "credits" && totalCreditsToDeduct > 0) {
      const deductResult = await creditsService.deductCredits({
        organizationId: params.organizationId,
        amount: chargeReceipt.totalAmountUsd,
        description: `MCP: ${mcp.name} - ${params.toolName}`,
        metadata: {
          mcp_id: mcp.id,
          mcp_name: mcp.name,
          tool_name: params.toolName,
          creator_org_id: mcp.organization_id,
          // #22961 round 6 F3: the deducting path's debit is exactly the
          // proxy precharge's twin — without the recovery tag a crash after
          // this commit but before the settlement receipt insert left a
          // permanently unrecoverable debit (findOrphanPrecharges only sees
          // tagged rows).
          mcp_precharge: "v1",
          affiliate_fee: affiliateFeeCredits.toFixed(4),
          platform_fee: platformFeeCredits.toFixed(4),
          total_credits_charged: totalCreditsToDeduct.toFixed(4),
          base_amount_usd: formatOrganizationCreditUsd(chargeReceipt.baseAmountUsd),
          affiliate_fee_usd: formatOrganizationCreditUsd(chargeReceipt.affiliateFeeUsd),
          platform_fee_usd: formatOrganizationCreditUsd(chargeReceipt.platformFeeUsd),
          total_amount_usd: formatOrganizationCreditUsd(chargeReceipt.totalAmountUsd),
          credit_unit: ORGANIZATION_CREDIT_UNIT,
        },
      });

      if (!deductResult.success) {
        throw new Error("Insufficient credits");
      }
      paymentEventId = deductResult.transaction?.id ?? "";
      if (!paymentEventId) {
        // A successful debit without a durable transaction id cannot be
        // replay-protected; the payout legs must not run. The debit is NOT
        // silently kept: attempt the refund so the buyer is whole, then fail
        // closed (#22961). The proxy performs the same refund at its boundary.
        try {
          await creditsService.refundCredits({
            organizationId: params.organizationId,
            amount: chargeReceipt.totalAmountUsd,
            description: `MCP refund: ${mcp.name} (charge_without_transaction_id)`,
            metadata: {
              mcp_id: mcp.id,
              reason: "charge_without_transaction_id",
            },
          });
        } catch (refundError) {
          // error-policy:J6 best-effort teardown refund; the failure is logged
          // and the (already thrown) unkeyed-settlement error stays primary.
          logger.error("[UserMcps] Failed to refund unkeyed MCP charge", {
            mcpId: mcp.id,
            organizationId: params.organizationId,
            amountUsd: chargeReceipt.totalAmountUsd,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
        throw new Error(
          "MCP charge succeeded without a transaction id; refusing unkeyed settlement",
        );
      }
    } else if (params.paymentType === "x402") {
      // x402 confirmation is owned by #22327/#22839; this path still refuses
      // an unkeyed settlement — the provider payment event must name the event.
      paymentEventId =
        typeof params.metadata?.x402PaymentEventId === "string"
          ? params.metadata.x402PaymentEventId.trim()
          : "";
      if (!paymentEventId) {
        throw new Error(
          "x402 MCP settlement requires metadata.x402PaymentEventId; refusing unkeyed payout legs",
        );
      }
    }

    // Free tier (#22961): a zero-total credits call is NOT an economic event —
    // no debit, so there is no payment event to key a receipt on. Claiming one
    // with an empty key would poison the rail for every later free call.
    // Record the usage row and stats atomically and skip the authority.
    if (params.paymentType === "credits" && totalCreditsToDeduct === 0) {
      const claimed = await mcpUsageRepository.createWithStats(
        {
          mcp_id: mcp.id,
          organization_id: params.organizationId,
          user_id: params.userId ?? undefined,
          tool_name: params.toolName,
          request_count: 1,
          credits_charged: creditsCharged.toString(),
          base_amount_usd: formatOrganizationCreditUsd(chargeReceipt.baseAmountUsd),
          affiliate_fee_usd: formatOrganizationCreditUsd(chargeReceipt.affiliateFeeUsd),
          platform_fee_usd: formatOrganizationCreditUsd(chargeReceipt.platformFeeUsd),
          total_amount_usd: formatOrganizationCreditUsd(chargeReceipt.totalAmountUsd),
          fee_components_known: true,
          x402_amount_usd: (0).toString(),
          payment_type: params.paymentType,
          creator_earnings: (0).toString(),
          platform_earnings: (0).toString(),
          metadata: params.metadata ?? {},
        },
        { mcpId: mcp.id, creatorEarnings: 0, x402EarnedUsd: 0 },
      );
      return {
        success: true,
        creditsCharged,
        basePriceUsd: legacyMcpPointsToOrganizationCredits(creditsCharged),
        affiliateFeeUsd: chargeReceipt.affiliateFeeUsd,
        platformFeeUsd: chargeReceipt.platformFeeUsd,
        totalPriceUsd: chargeReceipt.totalAmountUsd,
        creditUnit: ORGANIZATION_CREDIT_UNIT,
        x402AmountUsd: 0,
        creatorEarnings: 0,
        settlementId: "",
        platformEarnings: 0,
        usageId: claimed.usage.id,
      };
    }

    return await this.applyMcpSettlement({
      mcp,
      buyerOrganizationId: params.organizationId,
      buyerUserId: params.userId ?? null,
      toolName: params.toolName,
      paymentType: params.paymentType,
      paymentEventId,
      creditsCharged,
      affiliateFeeCredits,
      platformFeeCredits,
      chargeReceipt,
      affiliateOwnerId,
      affiliateCodeId,
      metadata: params.metadata,
      x402AmountUsd,
    });
  }

  /**
   * Single settlement authority for one MCP purchase (#22961): claim the
   * first-committed-wins receipt, apply every missing payout leg exactly once
   * under settlement-scoped idempotency keys, and flip the receipt terminal.
   * Shared by `recordUsage` (which debits first) and
   * `recordUsageWithoutDeduction` (caller already debited).
   */
  private async applyMcpSettlement(params: {
    mcp: UserMcp;
    buyerOrganizationId: string;
    buyerUserId: string | null;
    toolName: string;
    paymentType: "credits" | "x402";
    paymentEventId: string;
    creditsCharged: number;
    affiliateFeeCredits: number;
    platformFeeCredits: number;
    chargeReceipt: McpUsageChargeReceipt;
    affiliateOwnerId: string | null;
    affiliateCodeId: string | null;
    metadata?: Record<string, unknown>;
    x402AmountUsd: number;
  }): Promise<UseMcpResult> {
    const { mcp } = params;
    const creatorSharePct =
      parseMcpSharePercentage(mcp.creator_share_percentage, "creator_share_percentage", 0) / 100;
    const platformSharePct =
      parseMcpSharePercentage(mcp.platform_share_percentage, "platform_share_percentage", 0) / 100;

    const creatorEarnings = params.creditsCharged * creatorSharePct;
    const platformEarnings = params.creditsCharged * platformSharePct + params.platformFeeCredits;

    // Live-side ownership claim (#22961 round-4 P0): on the credits rail the
    // payment event IS the precharge debit, and the durable sweep refunds
    // debits that never became receipts. Winning this row UPDATE is what makes
    // this delivery the sole owner of the settle-vs-refund decision; the sweep
    // gates on the same row (claimPrechargeForSweep), so a debit can never be
    // both settled and refunded. A lost race falls through to the receipt
    // lookup below, which resolves replay (receipt exists) vs refund (marker
    // says the sweep already paid the buyer back — fail closed, never
    // double-deliver).
    if (params.paymentType === "credits") {
      // Payment-event type guard (#27992 rebase): reconciliation callers can
      // surface refund/overage adjustment ids; a non-debit row must never key
      // payout legs regardless of how the id was selected upstream.
      if (!(await mcpSettlementsRepository.isDebitTransaction(params.paymentEventId))) {
        throw new Error(
          `MCP settlement payment event ${params.paymentEventId} is not a debit transaction; refusing unkeyed payout legs`,
        );
      }
      const ownsPrecharge = await mcpSettlementsRepository.claimPrechargeForSettlement(
        params.paymentEventId,
      );
      if (!ownsPrecharge) {
        // Legitimate replay: the first delivery's receipt row is exactly what
        // claim() re-reads below (first-committed-wins). A sweep-refunded
        // debit has no receipt row — distinguish it before any money moves.
        if (await mcpSettlementsRepository.prechargeSweptByRefund(params.paymentEventId)) {
          // Typed (#27992): this refusal crosses the MCP proxy's J7 boundary
          // where only `error.message` is recorded — a bare Error would leave
          // the incident unclassifiable in the error feed.
          throw new ElizaError(
            `MCP precharge ${params.paymentEventId} was refunded by the durable sweep; refusing to settle a refunded debit`,
            {
              code: "MCP_PRECHARGE_ALREADY_REFUNDED",
              context: { paymentEventId: params.paymentEventId, mcpId: mcp.id },
              severity: "fatal",
            },
          );
        }
      }
    }

    // First-committed-wins authority. A concurrent duplicate or a retry of the
    // same payment event lands on the committed row; mismatched economics throw.
    // The buyer-debit FK slot is populated ONLY on the credits rail: a
    // UUID-shaped x402 provider id is not a credit transaction and must never
    // be bound to the tenant FK (#22961).
    const { settlement, created } = await mcpSettlementsRepository.claim({
      buyer_credit_transaction_id:
        params.paymentType === "credits" ? uuidOrNull(params.paymentEventId) : null,
      buyer_organization_id: params.buyerOrganizationId,
      buyer_user_id: params.buyerUserId,
      mcp_id: mcp.id,
      tool_name: params.toolName,
      payment_type: params.paymentType,
      payment_event_id: params.paymentEventId,
      affiliate_owner_id: params.affiliateOwnerId,
      affiliate_code_id: params.affiliateCodeId,
      creator_organization_id: mcp.organization_id,
      creator_user_id: mcp.created_by_user_id ?? null,
      base_amount_usd: formatOrganizationCreditUsd(params.chargeReceipt.baseAmountUsd),
      affiliate_fee_usd: formatOrganizationCreditUsd(params.chargeReceipt.affiliateFeeUsd),
      platform_fee_usd: formatOrganizationCreditUsd(params.chargeReceipt.platformFeeUsd),
      total_amount_usd: formatOrganizationCreditUsd(params.chargeReceipt.totalAmountUsd),
      creator_earnings_usd: legacyMcpPointsToOrganizationCredits(creatorEarnings).toFixed(6),
      platform_earnings_usd: legacyMcpPointsToOrganizationCredits(platformEarnings).toFixed(6),
      x402_amount_usd: (params.paymentType === "x402" ? params.x402AmountUsd : 0).toFixed(6),
    });
    if (!created && settlement.status === "settled") {
      // Exact terminal replay: return the stored receipt, change nothing.
      // Units stay the SAME as the first-delivery contract (legacy points for
      // creditsCharged/creatorEarnings, USD for the fee breakdown), so a
      // caller cannot observe different values for the same event (#22961).
      return {
        success: true,
        creditsCharged: params.creditsCharged,
        basePriceUsd: legacyMcpPointsToOrganizationCredits(params.creditsCharged),
        affiliateFeeUsd: params.chargeReceipt.affiliateFeeUsd,
        platformFeeUsd: params.chargeReceipt.platformFeeUsd,
        totalPriceUsd: params.chargeReceipt.totalAmountUsd,
        creditUnit: ORGANIZATION_CREDIT_UNIT,
        x402AmountUsd: params.x402AmountUsd,
        creatorEarnings,
        settlementId: settlement.id,
        platformEarnings,
        usageId: settlement.mcp_usage_id ?? "",
      };
    }
    return await this.applySettlementLegs(settlement, { metadata: params.metadata }, !created);
  }

  /**
   * Apply every missing payout leg of an already-claimed settlement receipt
   * (#22961). Shared by the live delivery path (via applyMcpSettlement) and
   * the durable recovery sweep (via resumeMcpSettlement): every leg checks
   * its completed-linkage column first, so re-driving a partially-applied
   * receipt is always safe.
   */
  private async applySettlementLegs(
    settlement: McpSettlement,
    legParams: { metadata?: Record<string, unknown> },
    wasAlreadyClaimed = false,
  ): Promise<UseMcpResult> {
    const mcp = await userMcpsRepository.getById(settlement.mcp_id);
    if (!mcp) {
      throw new Error(`MCP ${settlement.mcp_id} (settlement ${settlement.id}) not found`);
    }
    // The receipt snapshot is the ONLY economics source inside leg application.
    // The live path passes caller values that claim() has already verified match
    // this snapshot; the recovery path has no caller, so the legs below read
    // the snapshot columns directly and never recompute from mcp row state
    // (shares may have legitimately changed between claim and recovery).
    const creatorEarnings = Number(settlement.creator_earnings_usd);
    const platformEarnings = Number(settlement.platform_earnings_usd);

    // Units contract: mcp_usage.credits_charged and UseMcpResult.creditsCharged
    // stay LEGACY POINTS (100 = $1) exactly as the first-delivery path wrote
    // them; the receipt snapshot is USD, so convert once, losslessly (the
    // canonical micro-grid divides cleanly by 100).
    const creditsChargedPoints = organizationCreditsToLegacyMcpPoints(
      Number(settlement.base_amount_usd),
    );
    const creatorEarningsPoints = organizationCreditsToLegacyMcpPoints(creatorEarnings);
    const platformEarningsPoints = organizationCreditsToLegacyMcpPoints(platformEarnings);
    const x402AmountUsd = x402RailAmount(settlement);

    // Idempotency keys are settlement-scoped so a redelivery can never
    // double-credit a leg, and distinct calls to the same MCP each earn once.
    const affiliateSourceId = `mcp_settlement:${settlement.id}:affiliate`;
    const creatorSourceId = `mcp_settlement:${settlement.id}:creator_redeemable`;

    // Affiliate leg. The amount/owner/metadata of a replayed leg is verified
    // inside addEarnings (dedupe path), so a mismatched leg cannot slip in.
    if (
      Number(settlement.affiliate_fee_usd) > 0 &&
      settlement.affiliate_owner_id &&
      settlement.affiliate_code_id &&
      !settlement.affiliate_ledger_entry_id
    ) {
      const result = await redeemableEarningsService.addEarnings({
        userId: settlement.affiliate_owner_id,
        amount: Number(settlement.affiliate_fee_usd),
        source: "affiliate",
        sourceId: affiliateSourceId,
        dedupeBySourceId: true,
        // Replay-stable by construction: mcp.name is mutable (renames wedge
        // a strict replay compare), so the description derives only from the
        // immutable receipt (round-4 P1).
        description: `API Usage Affiliate Fee: ${settlement.mcp_id} - ${settlement.tool_name}`,
        metadata: {
          buyer_user_id: settlement.buyer_user_id,
          buyer_org_id: settlement.buyer_organization_id,
          mcp_id: mcp.id,
          mcp_settlement_id: settlement.id,
          total_amount_usd: settlement.total_amount_usd,
        },
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to credit affiliate earnings");
      }
      await mcpSettlementsRepository.recordLeg(settlement.id, {
        affiliate_ledger_entry_id: result.ledgerEntryId,
      });
    }

    // Creator organization-credit leg: the ledger's idempotency slot
    // (`stripe_payment_intent_id`, the established synthesized-key pattern
    // used by reserve/reconcile) makes the credit exactly-once; a replay with
    // different amount/org is rejected inside applyCreditIncrease.
    const creatorCreditKey = `mcp_settlement:${settlement.id}:creator_credit`;
    if (creatorEarnings > 0 && !settlement.creator_credit_transaction_id) {
      const creditResult = await creditsService.addCredits({
        organizationId: settlement.creator_organization_id,
        amount: creatorEarnings,
        description: `MCP Revenue: ${mcp.name} - ${settlement.tool_name}`,
        stripePaymentIntentId: creatorCreditKey,
        metadata: {
          mcp_id: mcp.id,
          mcp_settlement_id: settlement.id,
          consumer_org_id: settlement.buyer_organization_id,
          tool_name: settlement.tool_name,
          payment_type: settlement.payment_type,
          affiliate_fee_usd: settlement.affiliate_fee_usd,
          platform_fee_usd: settlement.platform_fee_usd,
        },
      });
      await mcpSettlementsRepository.recordLeg(settlement.id, {
        creator_credit_transaction_id: creditResult.transaction.id,
      });
    }

    // Creator redeemable-earnings leg (token redemption). A failed leg must
    // NOT be swallowed: settlement stays recoverable and the caller sees the
    // failure instead of a silently half-paid creator (#22961).
    if (creatorEarnings > 0 && settlement.creator_user_id && !settlement.creator_ledger_entry_id) {
      const result = await redeemableEarningsService.addEarnings({
        userId: settlement.creator_user_id,
        amount: creatorEarnings,
        source: "mcp",
        sourceId: creatorSourceId,
        dedupeBySourceId: true,
        description: `MCP earnings: ${mcp.name} - ${settlement.tool_name}`,
        metadata: {
          mcpId: mcp.id,
          mcp_settlement_id: settlement.id,
          mcpName: mcp.name,
          toolName: settlement.tool_name,
          consumerOrgId: settlement.buyer_organization_id,
          paymentType: settlement.payment_type,
          creatorEarningsUsd: settlement.creator_earnings_usd,
          affiliateFeeUsd: settlement.affiliate_fee_usd,
          platformFeeUsd: settlement.platform_fee_usd,
        },
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to credit creator redeemable earnings");
      }
      await mcpSettlementsRepository.recordLeg(settlement.id, {
        creator_ledger_entry_id: result.ledgerEntryId,
      });
    }

    // Usage row + stats counters in ONE statement: the usage insert's unique
    // settlement index is the exactly-once gate, and the stats bump rides in
    // the same transaction (RETURNING says whether this call inserted). A
    // separate increment would leave a crash window that re-delivery cannot
    // distinguish (bump lost forever, or double-bumped by the race loser).
    let usageId = settlement.mcp_usage_id ?? "";
    if (!usageId) {
      const claimed = await mcpUsageRepository.createWithStats(
        {
          mcp_id: mcp.id,
          organization_id: settlement.buyer_organization_id,
          user_id: settlement.buyer_user_id ?? undefined,
          tool_name: settlement.tool_name,
          request_count: 1,
          credits_charged: creditsChargedPoints.toString(),
          base_amount_usd: settlement.base_amount_usd,
          affiliate_fee_usd: settlement.affiliate_fee_usd,
          platform_fee_usd: settlement.platform_fee_usd,
          total_amount_usd: settlement.total_amount_usd,
          fee_components_known: true,
          x402_amount_usd: x402AmountUsd.toString(),
          payment_type: settlement.payment_type,
          creator_earnings: creatorEarningsPoints.toString(),
          platform_earnings: platformEarningsPoints.toString(),
          metadata: legParams.metadata ?? {},
          settlement_id: settlement.id,
        },
        {
          mcpId: mcp.id,
          creatorEarnings: creatorEarningsPoints,
          x402EarnedUsd: x402AmountUsd,
        },
      );
      usageId = claimed.usage.id;
      // Link unconditionally, not only when this call inserted: a crash
      // between the usage insert and recordLeg leaves the receipt without
      // mcp_usage_id, and a recovery that skipped linking could flip the
      // receipt terminal with the leg unreferenced.
      await mcpSettlementsRepository.recordLeg(settlement.id, {
        mcp_usage_id: usageId,
      });
    }

    const finalSettlement = await mcpSettlementsRepository.markSettled(settlement.id);
    if (!finalSettlement) {
      throw new Error("MCP settlement terminal transition lost its authority row");
    }

    logger.info("[UserMcps] Recorded usage", {
      mcpId: mcp.id,
      toolName: settlement.tool_name,
      creditsCharged: creditsChargedPoints,
      creatorEarnings,
      settlementId: settlement.id,
      replayed: wasAlreadyClaimed,
    });

    return {
      success: true,
      creditsCharged: creditsChargedPoints,
      basePriceUsd: Number(settlement.base_amount_usd),
      affiliateFeeUsd: Number(settlement.affiliate_fee_usd),
      platformFeeUsd: Number(settlement.platform_fee_usd),
      totalPriceUsd: Number(settlement.total_amount_usd),
      creditUnit: ORGANIZATION_CREDIT_UNIT,
      x402AmountUsd,
      creatorEarnings: creatorEarningsPoints,
      settlementId: settlement.id,
      platformEarnings: platformEarningsPoints,
      usageId,
    };
  }

  /**
   * Durable recovery for an interrupted MCP settlement (#22961): re-drive the
   * missing payout legs of a `settling` receipt from its immutable snapshot.
   *
   * The proxy's post-success settlement write is best-effort (the proxied
   * response already succeeded), so a Worker eviction or transient DB failure
   * can leave a receipt with the buyer debited but payout legs unapplied.
   * This entry point has NO caller-supplied economics: every amount, owner,
   * and key is read from the receipt itself, and each leg's idempotency key
   * (`mcp_settlement:<id>:<leg>`) makes the retry exactly-once per leg.
   */
  async resumeMcpSettlement(
    settlementId: string,
  ): Promise<{ resumed: boolean; result?: UseMcpResult; error?: string }> {
    const settlement = await mcpSettlementsRepository.getById(settlementId);
    if (!settlement) {
      return { resumed: false, error: `settlement ${settlementId} not found` };
    }
    if (settlement.status === "settled") {
      return { resumed: false };
    }
    try {
      const result = await this.applySettlementLegs(settlement, {}, true);
      return { resumed: true, result };
    } catch (error) {
      // error-policy:J7 the sweep is a diagnostic recovery lane; the receipt
      // stays `settling` and the next sweep retries. A permanently failing
      // leg is surfaced in the sweep stats for operator escalation.
      logger.error("[UserMcps] Settlement resume failed", {
        settlementId,
        paymentEventId: settlement.payment_event_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        resumed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Durable recovery lane for MCP settlements (#22961), driven by the
   * /api/cron/sweep-credit-reservations schedule:
   *  1. resume every settling receipt past the grace window (exactly-once
   *     per leg, economics from the receipt snapshot only);
   *  2. refund orphaned precharges — credits-rail debits tagged
   *     `mcp_precharge: v1` that never became a settlement and were never
   *     refunded. The refund carries `mcp_precharge_refund_for` so a second
   *     sweep pass never double-refunds.
   */
  async sweepMcpSettlements(): Promise<{
    resumed: number;
    resumeFailures: number;
    orphanRefunds: number;
    orphanRefundFailures: number;
  }> {
    const stats = {
      resumed: 0,
      resumeFailures: 0,
      orphanRefunds: 0,
      orphanRefundFailures: 0,
    };
    const due = await mcpSettlementsRepository.listDueForResume();
    for (const settlement of due) {
      const outcome = await this.resumeMcpSettlement(settlement.id);
      if (outcome.error) {
        stats.resumeFailures += 1;
      } else if (outcome.resumed) {
        stats.resumed += 1;
      }
    }

    const orphans = await mcpSettlementsRepository.findOrphanPrecharges();
    for (const debit of orphans) {
      // Atomic ownership claim BEFORE the refund (round-4 P0): the marker
      // write arbitrates settle-vs-refund against a concurrent LIVE delivery
      // claiming the same debit — whoever wins the UPDATE owns the economic
      // decision, so a live settlement and a sweep refund can never both
      // happen. It does NOT single-handedly serialize two OVERLAPPING sweep
      // passes: claimPrechargeForSweep deliberately re-admits 'refunding'
      // claims so a crashed pass stays retryable, so two overlapping passes
      // can both see `true`. What prevents a double refund in THAT case is
      // the debit-scoped idempotency key below, deduped by
      // applyCreditIncrease's ON CONFLICT on stripe_payment_intent_id in
      // credits.ts — a different module, which is why it is named here
      // explicitly (#27992 note 1).
      const claimed = await mcpSettlementsRepository.claimPrechargeForSweep(debit.id);
      if (!claimed.claimed) {
        continue;
      }
      // Net remainder from the CLAIM, not the finder (#27992 r2 F1): a rail
      // reconcile refund can commit between the finder read and the claim; the
      // claim computes the linked-refund sum under the debit row's FOR UPDATE
      // lock and returns the authoritative net to refund. The exact PG numeric
      // TEXT is passed straight through to refundCredits (AddCreditsParams
      // accepts strings precisely to avoid binary floating-point money
      // conversion); Number() is used ONLY for the detection guard below —
      // converting the refund itself would degrade the final micro-unit at
      // numeric(16,6)'s domain edge (#27992 r4 F2).
      const refundAmountText = claimed.netRefundable ?? "";
      const refundAmount = Number(refundAmountText);
      const grossRefundAmount = Math.abs(Number(debit.amount));
      const alreadyRefunded = grossRefundAmount - refundAmount;
      if (
        !Number.isFinite(refundAmount) ||
        !Number.isFinite(grossRefundAmount) ||
        refundAmount <= 0 ||
        alreadyRefunded < -1e-9
      ) {
        logger.error("[UserMcps] Orphan precharge has unusable amount; skipping", {
          debitId: debit.id,
          amount: debit.amount,
        });
        stats.orphanRefundFailures += 1;
        continue;
      }
      try {
        await creditsService.refundCredits({
          organizationId: debit.organization_id,
          amount: refundAmountText,
          description: "MCP refund: settlement never created (durable sweep)",
          // Refund idempotency key (round-4 P0): overlapping sweep passes and
          // retries all dedupe on THIS debit-scoped key — applyCreditIncrease
          // (credits.ts) treats it as the idempotency key via its ON CONFLICT
          // on stripe_payment_intent_id. The field name is Stripe-shaped for
          // historical reasons, but the value is NOT a Stripe payment intent
          // and the dedupe is NOT Stripe-specific: never validate it as an
          // intent id or skip it when no payment intent exists — doing so
          // would silently remove the only double-refund guarantee under
          // overlapping sweeps (#27992 note 2). The dedupe contract itself is
          // regression-tested in mcp-settlement-balanced-ledger.test.ts.
          stripePaymentIntentId: `mcp_precharge_refund:${debit.id}`,
          metadata: {
            mcp_precharge_refund_for: debit.id,
            reason: "orphan_precharge_settlement_never_created",
            mcp_id: typeof debit.metadata?.mcp_id === "string" ? debit.metadata.mcp_id : null,
          },
        });
        // Terminal marker AFTER the refund commits (#22961 round 6 F2): the
        // claim state is 'refunding' until the money has actually moved, so
        // a transient refund failure leaves a retryable claim that the next
        // pass re-finds and re-attempts (idempotency key dedupes) instead of
        // a frozen 'true' marker over a permanently debited buyer.
        await mcpSettlementsRepository.markPrechargeRefunded(debit.id);
        stats.orphanRefunds += 1;
      } catch (error) {
        // error-policy:J7 sweep is the diagnostic recovery boundary; the
        // failed refund keeps its retryable 'refunding' claim — the next pass
        // re-finds it via the candidate predicate and retries under the same
        // debit-scoped idempotency key — and the failure is counted for
        // operator escalation.
        logger.error("[UserMcps] Failed to refund orphan MCP precharge", {
          debitId: debit.id,
          organizationId: debit.organization_id,
          error: error instanceof Error ? error.message : String(error),
        });
        stats.orphanRefundFailures += 1;
      }
    }
    return stats;
  }

  /**
   * Record MCP usage WITHOUT deducting credits (for pre-paid requests)
   *
   * Use this when credits have already been deducted by the caller.
   * This only handles revenue distribution and usage tracking.
   *
   * Settlement authority (#22961): the caller's completed precharge defines
   * the economic event. `metadata.preChargeTransactionId` is REQUIRED — a
   * missing key cannot be replay-protected, and an unprotectable money path
   * must fail closed, not free-wheel. The first committed `mcp_settlements`
   * row wins; a redelivery of the same event deduplicates or resumes only
   * missing legs, and the same key with different economics is rejected.
   */
  async recordUsageWithoutDeduction(params: UseMcpWithoutDeductionParams): Promise<UseMcpResult> {
    const mcp = await userMcpsRepository.getById(params.mcpId);
    if (!mcp) {
      throw new Error("MCP not found");
    }

    const creditsCharged = parseNonNegativeMcpBillingNumber(
      params.creditsCharged,
      "creditsCharged",
      0,
    );
    const affiliateFeeCredits = parseNonNegativeMcpBillingNumber(
      params.affiliateFeeCredits,
      "affiliateFeeCredits",
      0,
    );
    const platformFeeCredits = parseNonNegativeMcpBillingNumber(
      params.platformFeeCredits,
      "platformFeeCredits",
      0,
    );
    const chargeReceipt =
      params.chargeReceipt ??
      mcpUsageChargeReceiptFromLegacyPoints({
        basePoints: creditsCharged,
        affiliateFeePoints: affiliateFeeCredits,
        platformFeePoints: platformFeeCredits,
      });

    // Fail closed on a missing payment-event identity: without it no leg can
    // be replay-protected, and an accidental second settlement of the same
    // precharge would mint duplicate value (#22961).
    const paymentEventId =
      typeof params.metadata?.preChargeTransactionId === "string"
        ? params.metadata.preChargeTransactionId.trim()
        : "";
    if (!paymentEventId) {
      throw new Error(
        "MCP settlement requires metadata.preChargeTransactionId; refusing unkeyed payout legs",
      );
    }

    return await this.applyMcpSettlement({
      mcp,
      buyerOrganizationId: params.organizationId,
      buyerUserId: params.userId ?? null,
      toolName: params.toolName,
      paymentType: "credits",
      paymentEventId,
      creditsCharged,
      affiliateFeeCredits,
      platformFeeCredits,
      chargeReceipt,
      affiliateOwnerId: params.affiliateOwnerId ?? null,
      affiliateCodeId: params.affiliateCodeId ?? null,
      metadata: params.metadata,
      x402AmountUsd: 0,
    });
  }

  /**
   * Get usage stats for an MCP
   */
  async getStats(
    mcpId: string,
    organizationId: string,
  ): Promise<{
    totalRequests: number;
    /** @deprecated Legacy MCP pricing points (100 points = $1). */
    totalCreditsEarned: number;
    /** Canonical base MCP prices. */
    baseCloudCreditsCharged: string;
    affiliateFeesCloudCreditsCharged: string;
    platformFeesCloudCreditsCharged: string;
    totalCloudCreditsCharged: string;
    feeComponentsKnown: boolean;
    creditUnit: typeof ORGANIZATION_CREDIT_UNIT;
    totalX402EarnedUsd: number;
    uniqueUsers: number;
  }> {
    const mcp = await userMcpsRepository.getById(mcpId);
    if (!mcp) {
      throw new Error("MCP not found");
    }
    if (mcp.organization_id !== organizationId) {
      throw new Error("Unauthorized");
    }

    const stats = await mcpUsageRepository.getStats(mcpId);
    return {
      totalRequests: stats.totalRequests,
      totalCreditsEarned: stats.totalCreditsCharged,
      baseCloudCreditsCharged: stats.baseAmountUsd,
      affiliateFeesCloudCreditsCharged: stats.affiliateFeeUsd,
      platformFeesCloudCreditsCharged: stats.platformFeeUsd,
      totalCloudCreditsCharged: stats.totalAmountUsd,
      feeComponentsKnown: stats.feeComponentsKnown,
      creditUnit: ORGANIZATION_CREDIT_UNIT,
      totalX402EarnedUsd: stats.totalX402Usd,
      uniqueUsers: stats.uniqueOrgs,
    };
  }

  /**
   * Get the full endpoint URL for an MCP. Returns the RAW external backend URL
   * for external MCPs, so this is owner-only, never call it on a public/registry
   * surface (that leaks the raw URL and bypasses the metered proxy). Use
   * {@link getPublicProxyUrl} for anything a non-owner can see (#10917).
   */
  getEndpointUrl(mcp: UserMcp, baseUrl: string): string {
    if (mcp.endpoint_type === "external" && mcp.external_endpoint) {
      return mcp.external_endpoint;
    }

    // Container endpoint - would need to look up container URL
    if (mcp.endpoint_type === "container" && mcp.container_id) {
      // Container URL would be constructed from container's load_balancer_url
      return `${baseUrl}/api/mcp/proxy/${mcp.id}${mcp.endpoint_path ?? "/mcp"}`;
    }

    return `${baseUrl}/api/mcp/user/${mcp.slug}`;
  }

  /**
   * Public-safe endpoint URL: always the metered proxy for external/container
   * MCPs, never the raw `external_endpoint`, which would let a caller hit the
   * backend directly and bypass metering/charging. Use this everywhere a
   * non-owner can see the MCP (the registry, `?scope=public`). (#10917)
   */
  getPublicProxyUrl(mcp: UserMcp, baseUrl: string): string {
    if (mcp.endpoint_type === "external" || mcp.endpoint_type === "container") {
      return `${baseUrl}/api/mcp/proxy/${mcp.id}${mcp.endpoint_path ?? "/mcp"}`;
    }
    return `${baseUrl}/api/mcp/user/${mcp.slug}`;
  }

  /**
   * Redact an MCP for a PUBLIC (non-owner) response: drop the raw
   * `external_endpoint` (metered-proxy bypass) and the internal
   * `created_by_user_id` (cross-org user identity), so `?scope=public` /
   * combined listings never hand a foreign caller either. (#10918)
   */
  toPublicMcp(mcp: UserMcp): PublicUserMcp {
    return { ...mcp, external_endpoint: null, created_by_user_id: null };
  }

  /**
   * Return the owner view unchanged, otherwise redact the public view.
   */
  toVisibleMcpForOrganization(mcp: UserMcp, organizationId: string): UserMcp | PublicUserMcp {
    return mcp.organization_id === organizationId ? mcp : this.toPublicMcp(mcp);
  }

  /** Add the canonical USD price while retaining explicit legacy point fields. */
  toApiMcp(mcp: UserMcp | PublicUserMcp): ApiUserMcp {
    const price = resolveCanonicalMcpPrice(mcp);
    return {
      ...mcp,
      credit_unit: ORGANIZATION_CREDIT_UNIT,
      price_usd: price.priceUsd,
      price_available: price.priceAvailable,
      legacy_credits_per_request: mcp.pricing_type === "credits" ? mcp.credits_per_request : null,
      total_creator_revenue_usd: resolveCreatorRevenueUsd(mcp),
    };
  }

  /**
   * Convert UserMcp to registry format
   */
  toRegistryFormat(
    mcp: UserMcp,
    baseUrl: string,
  ): {
    id: string;
    name: string;
    description: string;
    category: string;
    endpoint: string;
    type: "streamable-http" | "stdio";
    version: string;
    status: "live" | "coming_soon" | "maintenance";
    icon: string;
    color: string;
    toolCount: number;
    features: string[];
    pricing: {
      type: "free" | "credits" | "x402";
      description: string;
      creditUnit: typeof ORGANIZATION_CREDIT_UNIT;
      priceUsd?: string;
      /** @deprecated Legacy MCP pricing points (100 points = $1). */
      pricePerRequest?: string;
    };
    x402Enabled: boolean;
    documentation?: string;
    creator: {
      organizationId: string;
      verified: boolean;
    };
    configTemplate: {
      servers: Record<
        string,
        {
          type: "streamable-http" | "stdio";
          url: string;
        }
      >;
    };
  } {
    // The registry is a public discovery surface, advertise the metered proxy,
    // never the raw external backend URL (that would bypass metering). (#10917)
    const endpoint = this.getPublicProxyUrl(mcp, baseUrl);

    let pricingDescription = "Free to use";
    const price = resolveCanonicalMcpPrice(mcp);
    if (!price.priceAvailable) {
      pricingDescription = "Price unavailable";
    } else if (mcp.pricing_type === "credits") {
      pricingDescription = `$${price.priceUsd} in cloud credit per request`;
    } else if (mcp.pricing_type === "x402") {
      pricingDescription = `$${mcp.x402_price_usd} per request`;
    }

    return {
      id: `user-${mcp.id}`,
      name: mcp.name,
      description: mcp.description,
      category: mcp.category,
      endpoint,
      type: mcp.transport_type as "streamable-http" | "stdio",
      version: mcp.version,
      status: mcp.status === "live" ? "live" : "coming_soon",
      icon: mcp.icon ?? "puzzle",
      color: mcp.color ?? "#6366F1",
      toolCount: mcp.tools.length,
      features: mcp.tools.map((t) => t.name),
      pricing: {
        type: mcp.pricing_type ?? "free",
        description: pricingDescription,
        creditUnit: ORGANIZATION_CREDIT_UNIT,
        priceUsd: price.priceUsd ?? undefined,
        pricePerRequest:
          mcp.pricing_type === "credits"
            ? mcp.credits_per_request?.toString()
            : mcp.pricing_type === "x402"
              ? mcp.x402_price_usd?.toString()
              : undefined,
      },
      x402Enabled: mcp.x402_enabled,
      documentation: mcp.documentation_url ?? undefined,
      creator: {
        organizationId: mcp.organization_id,
        verified: mcp.is_verified,
      },
      configTemplate: {
        servers: {
          [mcp.slug]: {
            type: mcp.transport_type as "streamable-http" | "stdio",
            url: endpoint,
          },
        },
      },
    };
  }
}

export const userMcpsService = new UserMcpsService();
