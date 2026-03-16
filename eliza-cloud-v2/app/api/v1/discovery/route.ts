/**
 * Discovery API
 *
 * Provides a single endpoint to discover services from
 * local Eliza Cloud agents and MCPs.
 *
 * @route GET /api/v1/discovery
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { userMcpsService } from "@/lib/services/user-mcps";
import { charactersService } from "@/lib/services/characters";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { createHash } from "crypto";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// Types
// ============================================================================

type ServiceType = "agent" | "mcp" | "a2a" | "app";

interface ServicePricing {
  type: "free" | "credits" | "x402" | "subscription";
  amount?: number;
  currency?: string;
  description?: string;
}

interface DiscoveredService {
  id: string;
  name: string;
  description: string;
  type: ServiceType;
  source: "local";
  image?: string;
  category?: string;
  tags: string[];
  active: boolean;
  pricing?: ServicePricing;
  a2aEndpoint?: string;
  mcpEndpoint?: string;
  mcpTools?: string[];
  a2aSkills?: string[];
  x402Support: boolean;
  // organizationId and creatorId intentionally removed for privacy
  verified?: boolean;
  slug?: string;
}

interface DiscoveryResponse {
  services: DiscoveredService[];
  total: number;
  hasMore: boolean;
  pagination: {
    limit: number;
    offset: number;
  };
  cached?: boolean;
}

// ============================================================================
// Request Validation
// ============================================================================

const querySchema = z.object({
  query: z.string().optional(),
  types: z
    .string()
    .transform((s) => s.split(",") as ServiceType[])
    .optional(),
  categories: z
    .string()
    .transform((s) => s.split(","))
    .optional(),
  tags: z
    .string()
    .transform((s) => s.split(","))
    .optional(),
  mcpTools: z
    .string()
    .transform((s) => s.split(","))
    .optional(),
  a2aSkills: z
    .string()
    .transform((s) => s.split(","))
    .optional(),
  x402Only: z
    .string()
    .transform((s) => s === "true")
    .optional(),
  activeOnly: z
    .string()
    .transform((s) => s === "true")
    .optional()
    .default("true"),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

// ============================================================================
// Route Handler
// ============================================================================

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams);

  // Validate query parameters
  const parseResult = querySchema.safeParse(rawParams);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parseResult.error.issues },
      { status: 400 },
    );
  }

  const params = parseResult.data;

  // Generate cache key from params
  const paramHash = createHash("md5")
    .update(JSON.stringify(params))
    .digest("hex")
    .substring(0, 12);
  const cacheKey = CacheKeys.discovery.list(paramHash);

  // Use cache for discovery results
  const cached = await cache.get<DiscoveryResponse>(cacheKey);
  if (cached) {
    return NextResponse.json({
      ...cached,
      cached: true,
    });
  }

  logger.debug("[Discovery] Cache miss, fetching fresh data", { params });

  const services: DiscoveredService[] = [];
  const types = params.types ?? ["agent", "mcp", "app"];

  // Fetch local agents
  if (types.includes("agent")) {
    const localAgents = await fetchLocalAgents(params);
    services.push(...localAgents);
  }

  // Fetch local MCPs
  if (types.includes("mcp")) {
    const localMcps = await fetchLocalMcps(params);
    services.push(...localMcps);
  }

  // ========================================================================
  // Apply filtering and pagination
  // ========================================================================

  let filtered = services;

  // Text search
  if (params.query) {
    const query = params.query.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query),
    );
  }

  // Filter by x402 support
  if (params.x402Only) {
    filtered = filtered.filter((s) => s.x402Support);
  }

  // Filter by active status
  if (params.activeOnly) {
    filtered = filtered.filter((s) => s.active);
  }

  // Filter by categories
  if (params.categories?.length) {
    filtered = filtered.filter(
      (s) => s.category && params.categories!.includes(s.category),
    );
  }

  // Filter by tags
  if (params.tags?.length) {
    filtered = filtered.filter((s) =>
      s.tags.some((tag) => params.tags!.includes(tag)),
    );
  }

  // Sort by name
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  // Pagination
  const total = filtered.length;
  const paginated = filtered.slice(params.offset, params.offset + params.limit);

  const result: DiscoveryResponse = {
    services: paginated,
    total,
    hasMore: params.offset + paginated.length < total,
    pagination: {
      limit: params.limit,
      offset: params.offset,
    },
  };

  // Cache the result
  await cache.set(cacheKey, result, CacheTTL.discovery.list);

  return NextResponse.json({
    ...result,
    cached: false,
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetch local public agents
 */
async function fetchLocalAgents(
  params: z.infer<typeof querySchema>,
): Promise<DiscoveredService[]> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

  // Get all public characters
  let characters = await charactersService.listPublic();

  // Apply basic filtering
  if (params.query) {
    const query = params.query.toLowerCase();
    characters = characters.filter(
      (char) =>
        char.name.toLowerCase().includes(query) ||
        (typeof char.bio === "string" &&
          char.bio.toLowerCase().includes(query)) ||
        (Array.isArray(char.bio) &&
          char.bio.some((b) => b.toLowerCase().includes(query))),
    );
  }

  if (params.categories?.length) {
    characters = characters.filter((char) =>
      params.categories?.includes(char.category ?? ""),
    );
  }

  // Apply pagination
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  characters = characters.slice(offset, offset + limit);

  return characters.map((char): DiscoveredService => {
    const bio = Array.isArray(char.bio) ? char.bio.join(" ") : char.bio;

    return {
      id: char.id,
      name: char.name,
      description: bio,
      type: "agent",
      source: "local",
      image: char.avatar_url ?? undefined,
      category: char.category ?? undefined,
      tags: char.tags ?? [],
      active: true,
      // Endpoints are publicly discoverable but still require API key authentication when called
      a2aEndpoint: `${baseUrl}/api/agents/${char.id}/a2a`,
      mcpEndpoint: `${baseUrl}/api/agents/${char.id}/mcp`,
      mcpTools: [],
      a2aSkills: [],
      x402Support: false,
      // Note: organizationId and creatorId intentionally omitted for privacy
      verified: false,
      slug: char.slug ?? undefined,
      pricing: char.monetization_enabled
        ? {
            type: "credits",
            description: `${char.inference_markup_percentage}% markup on inference costs`,
          }
        : { type: "free", description: "Free to use" },
    };
  });
}

/**
 * Fetch local MCPs from the registry
 */
async function fetchLocalMcps(
  params: z.infer<typeof querySchema>,
): Promise<DiscoveredService[]> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

  const mcps = await userMcpsService.listPublic({
    category: params.categories?.[0],
    search: params.query,
    limit: params.limit,
    offset: params.offset,
  });

  return mcps.map(
    (mcp): DiscoveredService => ({
      id: mcp.id,
      name: mcp.name,
      description: mcp.description,
      type: "mcp",
      source: "local",
      category: mcp.category,
      tags: mcp.tags ?? [],
      active: mcp.status === "live",
      // Endpoint is publicly discoverable but still requires API key authentication when called
      mcpEndpoint: userMcpsService.getEndpointUrl(mcp, baseUrl),
      mcpTools: mcp.tools.map((t) => t.name),
      a2aSkills: [],
      x402Support: mcp.x402_enabled,
      // Note: organizationId and creatorId intentionally omitted for privacy
      verified: mcp.is_verified,
      slug: mcp.slug,
      pricing:
        mcp.pricing_type === "free"
          ? { type: "free", description: "Free to use" }
          : mcp.pricing_type === "credits"
            ? {
                type: "credits",
                amount: Number(mcp.credits_per_request),
                description: `${mcp.credits_per_request} credits per request`,
              }
            : {
                type: "x402",
                amount: Number(mcp.x402_price_usd),
                currency: "USD",
                description: `$${mcp.x402_price_usd} per request`,
              },
    }),
  );
}
