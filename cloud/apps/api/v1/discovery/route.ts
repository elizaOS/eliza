/**
 * Discovery API
 *
 * Provides a single endpoint to discover services from
 * local Eliza Cloud agents and MCPs.
 *
 * @route GET /api/v1/discovery
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { charactersService } from "@/lib/services/characters/characters";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

type ServiceType = "agent" | "mcp" | "a2a" | "app";
type ServiceSource = "cloud" | "local";

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
  source: ServiceSource;
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

function resolveDiscoverySource(baseUrl: string): ServiceSource {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")
      ? "local"
      : "cloud";
  } catch {
    return "local";
  }
}

function getDiscoveryKey(service: DiscoveredService): string {
  return [
    service.type,
    service.slug || service.mcpEndpoint || service.a2aEndpoint,
    service.name.trim().toLowerCase(),
    service.description.trim().toLowerCase(),
  ]
    .filter(Boolean)
    .join("::");
}

function getServiceScore(service: DiscoveredService): number {
  return (
    Number(service.active) +
    Number(Boolean(service.verified)) * 2 +
    Number(Boolean(service.slug)) +
    Number(Boolean(service.image))
  );
}

function dedupeDiscoveredServices(services: DiscoveredService[]): DiscoveredService[] {
  const unique = new Map<string, DiscoveredService>();

  for (const service of services) {
    const key = getDiscoveryKey(service);
    const existing = unique.get(key);
    if (!existing || getServiceScore(service) > getServiceScore(existing)) {
      unique.set(key, service);
    }
  }

  return [...unique.values()];
}

async function sha256Short(input: string, length = 12): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, length);
}

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
    .default(true),
  limit: z.coerce.number().min(1).max(200).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const rawParams = Object.fromEntries(url.searchParams);

    const parseResult = querySchema.safeParse(rawParams);
    if (!parseResult.success) {
      return c.json({ error: "Invalid parameters", details: parseResult.error.issues }, 400);
    }

    const params = parseResult.data;

    const paramHash = await sha256Short(JSON.stringify(params), 12);
    const cacheKey = CacheKeys.discovery.list(paramHash);

    const cached = await cache.get<DiscoveryResponse>(cacheKey);
    if (cached) {
      return c.json({
        ...cached,
        cached: true,
      });
    }

    logger.debug("[Discovery] Cache miss, fetching fresh data", { params });

    const services: DiscoveredService[] = [];
    const types = params.types ?? ["agent", "mcp", "app"];

    if (types.includes("agent")) {
      const localAgents = await fetchLocalAgents(params, c.env.NEXT_PUBLIC_APP_URL);
      services.push(...localAgents);
    }

    if (types.includes("mcp")) {
      const localMcps = await fetchLocalMcps(params, c.env.NEXT_PUBLIC_APP_URL);
      services.push(...localMcps);
    }

    let filtered = services;

    if (params.query) {
      const query = params.query.toLowerCase();
      filtered = filtered.filter(
        (s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
      );
    }

    if (params.x402Only) {
      filtered = filtered.filter((s) => s.x402Support);
    }

    if (params.activeOnly) {
      filtered = filtered.filter((s) => s.active);
    }

    if (params.categories?.length) {
      filtered = filtered.filter((s) => s.category && params.categories!.includes(s.category));
    }

    if (params.tags?.length) {
      filtered = filtered.filter((s) => s.tags.some((tag) => params.tags!.includes(tag)));
    }

    filtered = dedupeDiscoveredServices(filtered);
    filtered.sort((a, b) => a.name.localeCompare(b.name));

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

    await cache.set(cacheKey, result, CacheTTL.discovery.list);

    return c.json({
      ...result,
      cached: false,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

async function fetchLocalAgents(
  params: z.infer<typeof querySchema>,
  appUrlEnv?: string,
): Promise<DiscoveredService[]> {
  const baseUrl = appUrlEnv || "https://www.elizacloud.ai";
  const source = resolveDiscoverySource(baseUrl);

  let characters = await charactersService.listPublic({
    search: params.query,
    category: params.categories?.[0],
    limit: params.limit,
    offset: params.offset,
  });

  if (params.query) {
    const query = params.query.toLowerCase();
    // SQL search already covers name; this also matches bio (jsonb).
    characters = characters.filter(
      (char) =>
        char.name.toLowerCase().includes(query) ||
        (typeof char.bio === "string" && char.bio.toLowerCase().includes(query)) ||
        (Array.isArray(char.bio) && char.bio.some((b) => b.toLowerCase().includes(query))),
    );
  }

  if (params.categories && params.categories.length > 1) {
    // Repo filters on the first category; filter the rest in-memory.
    characters = characters.filter((char) => params.categories?.includes(char.category ?? ""));
  }

  return characters.map((char): DiscoveredService => {
    const bio = Array.isArray(char.bio) ? char.bio.join(" ") : char.bio;
    const slug = "slug" in char ? (char as { slug?: string }).slug : undefined;

    return {
      id: char.id,
      name: char.name,
      description: bio,
      type: "agent",
      source,
      image: char.avatar_url ?? undefined,
      category: char.category ?? undefined,
      tags: char.tags ?? [],
      active: true,
      a2aEndpoint: `${baseUrl}/api/agents/${char.id}/a2a`,
      mcpEndpoint: `${baseUrl}/api/agents/${char.id}/mcp`,
      mcpTools: [],
      a2aSkills: ["web_search", "extract_page", "browser_session"],
      x402Support: false,
      verified: false,
      slug,
      pricing: char.monetization_enabled
        ? {
            type: "credits",
            description: `${char.inference_markup_percentage}% markup on inference costs`,
          }
        : { type: "free", description: "Free to use" },
    };
  });
}

async function fetchLocalMcps(
  params: z.infer<typeof querySchema>,
  appUrlEnv?: string,
): Promise<DiscoveredService[]> {
  const baseUrl = appUrlEnv || "https://www.elizacloud.ai";
  const source = resolveDiscoverySource(baseUrl);

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
      source,
      category: mcp.category,
      tags: mcp.tags ?? [],
      active: mcp.status === "live",
      mcpEndpoint: userMcpsService.getEndpointUrl(mcp, baseUrl),
      mcpTools: mcp.tools.map((t) => t.name),
      a2aSkills: [],
      x402Support: mcp.x402_enabled,
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

export default app;
