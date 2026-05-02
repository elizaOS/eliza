/**
 * User MCPs Service
 *
 * Manages user-created MCP servers with monetization support.
 * Handles CRUD, revenue distribution, and discovery.
 */

import crypto from "crypto";
import { mcpUsageRepository, type UserMcp, userMcpsRepository } from "@/db/repositories";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { logger } from "@/lib/utils/logger";
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
  affiliateOwnerId?: string;
  affiliateCodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface UseMcpResult {
  success: boolean;
  creditsCharged: number;
  x402AmountUsd: number;
  creatorEarnings: number;
  platformEarnings: number;
  usageId: string;
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
      await assertSafeOutboundUrl(params.externalEndpoint);
    }

    // Check slug uniqueness
    const existing = await userMcpsRepository.getBySlug(params.slug, params.organizationId);
    if (existing) {
      throw new Error(`MCP with slug "${params.slug}" already exists`);
    }

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
      credits_per_request: params.creditsPerRequest?.toString() ?? "1.0000",
      x402_price_usd: params.x402PriceUsd?.toString() ?? "0.000100",
      x402_enabled: params.x402Enabled ?? false,
      creator_share_percentage: params.creatorSharePercentage?.toString() ?? "80.00",
      platform_share_percentage: (100 - (params.creatorSharePercentage ?? 80)).toString(),
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
  }): Promise<UserMcp[]> {
    return userMcpsRepository.listPublic({ ...options, status: "live" });
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
    if (params.creditsPerRequest !== undefined)
      updateData.credits_per_request = params.creditsPerRequest.toString();
    if (params.x402PriceUsd !== undefined)
      updateData.x402_price_usd = params.x402PriceUsd.toString();
    if (params.x402Enabled !== undefined) updateData.x402_enabled = params.x402Enabled;
    if (params.creatorSharePercentage !== undefined) {
      updateData.creator_share_percentage = params.creatorSharePercentage.toString();
      updateData.platform_share_percentage = (100 - params.creatorSharePercentage).toString();
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
      await assertSafeOutboundUrl(mcp.external_endpoint);
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

    const CREDITS_PER_DOLLAR = 100; // 1 cent = 1 credit

    if (params.paymentType === "credits") {
      creditsCharged = Number(mcp.credits_per_request);
    } else {
      x402AmountUsd = Number(mcp.x402_price_usd);
      // Convert to credits using configured rate
      creditsCharged = x402AmountUsd * CREDITS_PER_DOLLAR;
    }

    // WHY affiliate fee on top of creditsCharged: Customer pays base + affiliate% + platform%;
    // we pay affiliate from that. Referral splits are not used for MCP — keeps one payout
    // type per transaction so we never over-allocate.
    let affiliateFeeCredits = 0;
    let platformFeeCredits = 0;
    let affiliateOwnerId: string | null = null;
    let affiliateCodeId: string | null = null;

    if (params.userId) {
      try {
        const { affiliatesService } = await import("@/lib/services/affiliates");
        const referrer = await affiliatesService.getReferrer(params.userId!);
        if (referrer) {
          affiliateOwnerId = referrer.user_id;
          affiliateCodeId = referrer.id;
          const affiliatePercent = Number(referrer.markup_percent);
          const platformPercent = 20.0;

          affiliateFeeCredits = creditsCharged * (affiliatePercent / 100);
          platformFeeCredits = creditsCharged * (platformPercent / 100);
        }
      } catch (e) {
        logger.error(`[UserMcps] Error fetching referrer for ${params.userId}`, e);
      }
    }

    const totalCreditsToDeduct = creditsCharged + affiliateFeeCredits + platformFeeCredits;

    const creatorSharePct = Number(mcp.creator_share_percentage) / 100;
    const platformSharePct = Number(mcp.platform_share_percentage) / 100;

    const creatorEarnings = creditsCharged * creatorSharePct;
    const platformEarnings = creditsCharged * platformSharePct + platformFeeCredits;

    // Charge the consumer
    if (params.paymentType === "credits" && totalCreditsToDeduct > 0) {
      const deductResult = await creditsService.deductCredits({
        organizationId: params.organizationId,
        amount: totalCreditsToDeduct / CREDITS_PER_DOLLAR,
        description: `MCP: ${mcp.name} - ${params.toolName}`,
        metadata: {
          mcp_id: mcp.id,
          mcp_name: mcp.name,
          tool_name: params.toolName,
          creator_org_id: mcp.organization_id,
          affiliate_fee: affiliateFeeCredits.toFixed(4),
          platform_fee: platformFeeCredits.toFixed(4),
          total_credits_charged: totalCreditsToDeduct.toFixed(4),
        },
      });

      if (!deductResult.success) {
        throw new Error("Insufficient credits");
      }
    }

    // Credit Affiliate (per-call unique sourceId so each MCP call is credited; idempotency is per-call)
    if (affiliateFeeCredits > 0 && affiliateOwnerId && affiliateCodeId) {
      const callId = crypto.randomUUID();
      await redeemableEarningsService.addEarnings({
        userId: affiliateOwnerId,
        amount: affiliateFeeCredits / CREDITS_PER_DOLLAR,
        source: "affiliate",
        sourceId: `affiliate_mcp:${affiliateCodeId}:${callId}`,
        description: `API Usage Affiliate Fee: ${mcp.name} - ${params.toolName}`,
        metadata: {
          buyer_user_id: params.userId,
          buyer_org_id: params.organizationId,
          mcp_id: mcp.id,
        },
      });
    }

    // Credit the creator's organization credits (for platform operations)
    if (creatorEarnings > 0) {
      await creditsService.addCredits({
        organizationId: mcp.organization_id,
        amount: creatorEarnings / CREDITS_PER_DOLLAR,
        description: `MCP Revenue: ${mcp.name} - ${params.toolName}`,
        metadata: {
          mcp_id: mcp.id,
          consumer_org_id: params.organizationId,
          tool_name: params.toolName,
          payment_type: params.paymentType,
        },
      });

      // CRITICAL: Also credit the creator's redeemable_earnings for token redemption
      if (mcp.created_by_user_id) {
        const result = await redeemableEarningsService.addEarnings({
          userId: mcp.created_by_user_id,
          amount: creatorEarnings / CREDITS_PER_DOLLAR, // Convert credits to dollars
          source: "mcp",
          sourceId: mcp.id,
          description: `MCP earnings: ${mcp.name} - ${params.toolName}`,
          metadata: {
            mcpId: mcp.id,
            mcpName: mcp.name,
            toolName: params.toolName,
            consumerOrgId: params.organizationId,
            paymentType: params.paymentType,
            creditsEarned: creatorEarnings,
          },
        });

        if (!result.success) {
          logger.error("[UserMcps] Failed to credit redeemable earnings", {
            mcpId: mcp.id,
            creatorId: mcp.created_by_user_id,
            error: result.error,
          });
        }
      }
    }

    // Record usage
    const usage = await mcpUsageRepository.create({
      mcp_id: params.mcpId,
      organization_id: params.organizationId,
      user_id: params.userId,
      tool_name: params.toolName,
      request_count: 1,
      credits_charged: creditsCharged.toString(),
      x402_amount_usd: x402AmountUsd.toString(),
      payment_type: params.paymentType,
      creator_earnings: creatorEarnings.toString(),
      platform_earnings: platformEarnings.toString(),
      metadata: params.metadata ?? {},
    });

    // Update MCP stats
    await userMcpsRepository.incrementUsage(params.mcpId, creatorEarnings, x402AmountUsd);

    logger.info("[UserMcps] Recorded usage", {
      mcpId: params.mcpId,
      toolName: params.toolName,
      creditsCharged,
      creatorEarnings,
    });

    return {
      success: true,
      creditsCharged,
      x402AmountUsd,
      creatorEarnings,
      platformEarnings,
      usageId: usage.id,
    };
  }

  /**
   * Record MCP usage WITHOUT deducting credits (for pre-paid requests)
   *
   * Use this when credits have already been deducted by the caller.
   * This only handles revenue distribution and usage tracking.
   */
  async recordUsageWithoutDeduction(params: UseMcpWithoutDeductionParams): Promise<UseMcpResult> {
    const mcp = await userMcpsRepository.getById(params.mcpId);
    if (!mcp) {
      throw new Error("MCP not found");
    }

    const creditsCharged = params.creditsCharged;
    const affiliateFeeCredits = params.affiliateFeeCredits ?? 0;
    const platformFeeCredits = params.platformFeeCredits ?? 0;
    const creatorSharePct = Number(mcp.creator_share_percentage) / 100;
    const platformSharePct = Number(mcp.platform_share_percentage) / 100;

    const creatorEarnings = creditsCharged * creatorSharePct;
    const platformEarnings = creditsCharged * platformSharePct + platformFeeCredits;

    const CREDITS_PER_DOLLAR = 100; // 1 cent = 1 credit

    if (affiliateFeeCredits > 0 && params.affiliateOwnerId && params.affiliateCodeId) {
      const sourceSuffix =
        typeof params.metadata?.preChargeTransactionId === "string"
          ? params.metadata.preChargeTransactionId
          : crypto.randomUUID();
      const result = await redeemableEarningsService.addEarnings({
        userId: params.affiliateOwnerId,
        amount: affiliateFeeCredits / CREDITS_PER_DOLLAR,
        source: "affiliate",
        sourceId: `affiliate_mcp:${params.affiliateCodeId}:${sourceSuffix}`,
        dedupeBySourceId: true,
        description: `API Usage Affiliate Fee: ${mcp.name} - ${params.toolName}`,
        metadata: {
          buyer_user_id: params.userId,
          buyer_org_id: params.organizationId,
          mcp_id: mcp.id,
          total_credits_charged: creditsCharged + affiliateFeeCredits + platformFeeCredits,
        },
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to credit affiliate earnings");
      }
    }

    // Credit the creator's organization credits (for platform operations)
    if (creatorEarnings > 0) {
      await creditsService.addCredits({
        organizationId: mcp.organization_id,
        amount: creatorEarnings / CREDITS_PER_DOLLAR, // Convert to dollars
        description: `MCP Revenue: ${mcp.name} - ${params.toolName}`,
        metadata: {
          mcp_id: mcp.id,
          consumer_org_id: params.organizationId,
          tool_name: params.toolName,
          payment_type: "credits",
          affiliate_fee: affiliateFeeCredits.toFixed(4),
          platform_fee: platformFeeCredits.toFixed(4),
        },
      });

      // Credit the creator's redeemable_earnings for token redemption
      if (mcp.created_by_user_id) {
        const result = await redeemableEarningsService.addEarnings({
          userId: mcp.created_by_user_id,
          amount: creatorEarnings / CREDITS_PER_DOLLAR,
          source: "mcp",
          sourceId: mcp.id,
          description: `MCP earnings: ${mcp.name} - ${params.toolName}`,
          metadata: {
            mcpId: mcp.id,
            mcpName: mcp.name,
            toolName: params.toolName,
            consumerOrgId: params.organizationId,
            paymentType: "credits",
            creditsEarned: creatorEarnings,
            affiliateFeeCredits,
            platformFeeCredits,
          },
        });

        if (!result.success) {
          logger.error("[UserMcps] Failed to credit redeemable earnings", {
            mcpId: mcp.id,
            creatorId: mcp.created_by_user_id,
            error: result.error,
          });
        }
      }
    }

    // Record usage
    const usage = await mcpUsageRepository.create({
      mcp_id: params.mcpId,
      organization_id: params.organizationId,
      user_id: params.userId,
      tool_name: params.toolName,
      request_count: 1,
      credits_charged: creditsCharged.toString(),
      x402_amount_usd: "0", // No x402 for pre-paid
      payment_type: "credits",
      creator_earnings: creatorEarnings.toString(),
      platform_earnings: platformEarnings.toString(),
      metadata: params.metadata ?? {},
    });

    // Update MCP stats
    await userMcpsRepository.incrementUsage(params.mcpId, creatorEarnings, 0);

    logger.info("[UserMcps] Recorded usage (pre-paid)", {
      mcpId: params.mcpId,
      toolName: params.toolName,
      creditsCharged,
      creatorEarnings,
    });

    return {
      success: true,
      creditsCharged,
      x402AmountUsd: 0,
      creatorEarnings,
      platformEarnings,
      usageId: usage.id,
    };
  }

  /**
   * Get usage stats for an MCP
   */
  async getStats(
    mcpId: string,
    organizationId: string,
  ): Promise<{
    totalRequests: number;
    totalCreditsEarned: number;
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
      totalX402EarnedUsd: stats.totalX402Usd,
      uniqueUsers: stats.uniqueOrgs,
    };
  }

  /**
   * Get the full endpoint URL for an MCP
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
    const endpoint = this.getEndpointUrl(mcp, baseUrl);

    let pricingDescription = "Free to use";
    if (mcp.pricing_type === "credits") {
      pricingDescription = `${mcp.credits_per_request} credits per request`;
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
