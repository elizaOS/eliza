/**
 * Discovery API
 *
 * Provides a single endpoint to discover services from
 * local Eliza Cloud agents and MCPs.
 *
 * @route GET /api/v1/discovery
 */

import {
  legacyMcpPointsToOrganizationCredits,
  ORGANIZATION_CREDIT_UNIT,
} from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { charactersService } from "@/lib/services/characters/characters";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const serviceTypeSchema = z.enum(["agent", "mcp"]);
type ServiceType = z.infer<typeof serviceTypeSchema>;
type ServiceSource = "cloud" | "local";

interface ServicePricing {
  type: "free" | "credits" | "x402" | "subscription";
  /** @deprecated Legacy MCP amount; credits rows use cent-like pricing points. */
  amount?: number;
  /** Canonical dollar amount for USD-denominated prices. */
  amountUsd?: number;
  amountUnit?: "legacy_mcp_pricing_points" | "USD";
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
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".local")
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

function dedupeDiscoveredServices(
  services: DiscoveredService[],
): DiscoveredService[] {
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

/** The listPublic repositories clamp a single window to this many rows. */
const REPOSITORY_WINDOW_CLAMP = 200;
/**
 * Per-source scan ceiling for the bounded path (memory-only filters). Hitting
 * it forces hasMore=true so a truncated scan is never reported as complete.
 */
const BOUNDED_SCAN_CEILING = 1_000;
/**
 * Largest prefix an unauthenticated caller may make either path scan. The
 * bound applies to `offset + limit`, not offset alone: otherwise an offset at
 * the ceiling plus a 200-row page would exceed the advertised per-source cap.
 */
const MAX_PAGE_DEPTH = BOUNDED_SCAN_CEILING;

const querySchema = z
  .object({
    query: z.string().optional(),
    types: z
      .string()
      .transform((value) => value.split(",").map((type) => type.trim()))
      .pipe(z.array(serviceTypeSchema).min(1))
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
      .union([z.enum(["true", "false"]), z.literal("")])
      .optional()
      .transform((value) => value !== "false"),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_PAGE_DEPTH - 1)
      .optional()
      .default(0),
  })
  .refine((params) => params.offset + params.limit <= MAX_PAGE_DEPTH, {
    message: `offset + limit must not exceed ${MAX_PAGE_DEPTH}`,
    path: ["offset"],
  });

/** Compare strings in PostgreSQL `COLLATE "C"` order for UTF-8 databases. */
const UTF8_ENCODER = new TextEncoder();

export function compareUtf8ByteOrder(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const requestedActiveValues = url.searchParams.getAll("activeOnly");
    const requestedActive = requestedActiveValues[0];
    if (
      requestedActiveValues.length > 1 ||
      (requestedActive !== undefined &&
        requestedActive !== "" &&
        requestedActive !== "true" &&
        requestedActive !== "false")
    ) {
      return c.json(
        {
          error: "Invalid activeOnly",
          message:
            'activeOnly must be specified at most once as "true" or "false".',
        },
        400,
      );
    }
    const rawParams = Object.fromEntries(url.searchParams);

    const parseResult = querySchema.safeParse(rawParams);
    if (!parseResult.success) {
      return c.json(
        { error: "Invalid parameters", details: parseResult.error.issues },
        400,
      );
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

    const types: ServiceType[] = params.types ?? ["agent", "mcp"];

    // Pagination contract (#19076/#19083): the offset is applied exactly once,
    // to the merged agent+mcp stream ordered by name. Two regimes:
    //
    // - Exact path (no memory-only filters): `total` comes from dedicated SQL
    //   COUNT queries under listPublic's own conditions, and the page comes
    //   from per-source name-ordered prefix windows of depth offset+limit —
    //   sized to the request, so a first page fetches only what it needs, and
    //   correct at arbitrary offsets because the merged top-D is always
    //   contained in the union of each source's top-D — provided the SQL sort
    //   and the merge comparator agree. The repositories sort by name
    //   COLLATE "C" (id tiebreak) and the merge below compares UTF-8 bytes,
    //   including for astral-plane characters. The shared total order keeps
    //   prefix-window pagination from dropping or duplicating boundary rows.
    //
    // - Bounded path (tags / multi-category / x402Only, which SQL cannot
    //   express here): sources are scanned to exhaustion up to a per-source
    //   ceiling. If any source still had rows at the ceiling, hasMore is
    //   forced true and total is explicitly a lower bound — never a
    //   healthy-looking "complete" answer over a truncated scan.
    const memoryOnlyFilters =
      Boolean(params.tags?.length) ||
      (params.categories?.length ?? 0) > 1 ||
      Boolean(params.x402Only);

    const byNameUtf8ByteOrder = (
      a: DiscoveredService,
      b: DiscoveredService,
    ) => {
      const nameOrder = compareUtf8ByteOrder(a.name, b.name);
      return nameOrder !== 0 ? nameOrder : compareUtf8ByteOrder(a.id, b.id);
    };

    const applyMemoryFilters = (rows: DiscoveredService[]) => {
      let filtered = rows;
      if (params.query) {
        const query = params.query.toLowerCase();
        filtered = filtered.filter(
          (s) =>
            s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query),
        );
      }
      if (params.x402Only) {
        filtered = filtered.filter((s) => s.x402Support);
      }
      if (params.activeOnly) {
        filtered = filtered.filter((s) => s.active);
      }
      if (params.categories?.length) {
        filtered = filtered.filter(
          (s) => s.category && params.categories?.includes(s.category),
        );
      }
      if (params.tags?.length) {
        filtered = filtered.filter((s) =>
          s.tags.some((tag) => params.tags?.includes(tag)),
        );
      }
      return dedupeDiscoveredServices(filtered);
    };

    const pageDepth = params.offset + params.limit;
    // Exact path fetches only the requested depth; the bounded path scans to
    // exhaustion or its ceiling.
    let perSourceDepth = memoryOnlyFilters ? BOUNDED_SCAN_CEILING : pageDepth;

    let services: DiscoveredService[] = [];
    let anySourceTruncated = false;
    let windowed: DiscoveredService[] = [];

    // Dedupe can collapse rows inside the fetched prefixes (organizations may
    // expose the same slug+name+description MCP), underfilling the requested
    // window even though deeper unique rows exist. Refill by extending the
    // prefix depth until the window fills, every source is exhausted, or the
    // scan ceiling is reached. Refetching from row zero keeps the prefix
    // argument intact; extra passes only happen when a duplicate actually
    // collapsed inside the window, which is rare.
    for (;;) {
      services = [];
      anySourceTruncated = false;

      if (types.includes("agent")) {
        const { rows, truncated } = await fetchLocalAgents(
          params,
          perSourceDepth,
          c.env.NEXT_PUBLIC_APP_URL,
        );
        services.push(...rows);
        anySourceTruncated ||= truncated;
      }

      if (types.includes("mcp")) {
        const { rows, truncated } = await fetchLocalMcps(
          params,
          perSourceDepth,
          c.env.NEXT_PUBLIC_APP_URL,
        );
        services.push(...rows);
        anySourceTruncated ||= truncated;
      }

      windowed = applyMemoryFilters(services).sort(byNameUtf8ByteOrder);
      if (windowed.length >= pageDepth || !anySourceTruncated) break;
      if (perSourceDepth >= BOUNDED_SCAN_CEILING) break;
      // Grow geometrically (#19246): every duplicate identity found so far
      // hints at more, so doubling reaches any window within the scan
      // ceiling in O(log ceiling) passes instead of a linear crawl whose
      // pathological worst case re-walks the prefix ~ceiling/shortfall times.
      perSourceDepth = Math.min(BOUNDED_SCAN_CEILING, perSourceDepth * 2);
    }

    const filtered = windowed;
    const paginated = filtered.slice(
      params.offset,
      params.offset + params.limit,
    );

    let total: number;
    let hasMore: boolean;
    if (memoryOnlyFilters) {
      // Bounded path: exact when every source was exhausted; otherwise the
      // count is a lower bound and hasMore must not claim completion.
      total = filtered.length;
      hasMore = params.offset + paginated.length < total || anySourceTruncated;
    } else {
      // Exact path: dedicated counts under the same SQL conditions as the
      // list windows. The activeOnly filter is already exact here (agents are
      // always active; the mcp source lists status "live" only), and the
      // query filter is symmetric between list and count. Both counts are of
      // identities rather than raw rows: the mcp source counts DISTINCT
      // slug+name+description because cross-org republishes collapse under
      // getDiscoveryKey, while agent keys embed the character id and so can
      // never collide. Remaining divergences (SQL trim() vs JS .trim() over
      // non-space Unicode whitespace) can only over-report, never invent a
      // missing page.
      const counts = await Promise.all([
        types.includes("agent")
          ? charactersService.countPublicCatalog({
              search: params.query,
              category: sqlCategory(params),
            })
          : Promise.resolve(0),
        types.includes("mcp")
          ? userMcpsService.countPublic({
              search: params.query,
              category: sqlCategory(params),
            })
          : Promise.resolve(0),
      ]);
      total = counts[0] + counts[1];
      hasMore = params.offset + paginated.length < total;
    }

    const result: DiscoveryResponse = {
      services: paginated,
      total,
      hasMore,
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

/**
 * The SQL layer may only restrict by category when exactly one category is
 * requested. Multi-category requests take the bounded in-memory path, and
 * pushing just the first category down would starve the scan of every other
 * requested category's rows before the in-memory filter ever saw them.
 */
function sqlCategory(params: z.infer<typeof querySchema>): string | undefined {
  return params.categories?.length === 1 ? params.categories[0] : undefined;
}

/**
 * Fetches the first `depth` public agents in the shared name order, walking
 * repository windows as needed. `truncated` reports rows remained beyond the
 * requested depth, so bounded-path callers can refuse to claim completion.
 */
async function fetchLocalAgents(
  params: z.infer<typeof querySchema>,
  depth: number,
  appUrlEnv?: string,
): Promise<{ rows: DiscoveredService[]; truncated: boolean }> {
  const baseUrl = appUrlEnv || "https://cloud.eliza.app";
  const source = resolveDiscoverySource(baseUrl);

  let characters: Awaited<ReturnType<typeof charactersService.listPublic>> = [];
  // Read one row past the requested depth: a source holding exactly `depth`
  // rows must report truncated=false, and only the extra row distinguishes
  // exact fit from "more rows remain".
  const probeDepth = depth + 1;
  for (let sourceOffset = 0; characters.length < probeDepth; ) {
    const windowLimit = Math.min(
      probeDepth - characters.length,
      REPOSITORY_WINDOW_CLAMP,
    );
    const page = await charactersService.listPublic({
      search: params.query,
      category: sqlCategory(params),
      limit: windowLimit,
      offset: sourceOffset,
      orderBy: "name",
    });
    characters = characters.concat(page);
    sourceOffset += page.length;
    if (page.length < windowLimit) break;
  }
  const truncated = characters.length > depth;
  characters = characters.slice(0, depth);

  if (params.query) {
    const query = params.query.toLowerCase();
    // SQL search already covers name; this also matches bio (jsonb).
    characters = characters.filter(
      (char) =>
        char.name.toLowerCase().includes(query) ||
        (typeof char.bio === "string" &&
          char.bio.toLowerCase().includes(query)) ||
        // bio is caller-supplied jsonb stored verbatim by the character
        // routes, so array entries are not guaranteed to be strings — one
        // malformed public character must not 500 the whole public catalog
        // (#13637 class). Non-string entries simply can't match a text query.
        (Array.isArray(char.bio) &&
          char.bio.some(
            (b) => typeof b === "string" && b.toLowerCase().includes(query),
          )),
    );
  }

  if (params.categories && params.categories.length > 1) {
    // sqlCategory() pushes no category down when more than one is requested,
    // so the full requested set is narrowed here instead.
    characters = characters.filter((char) =>
      params.categories?.includes(char.category ?? ""),
    );
  }

  const rows = characters.map((char): DiscoveredService => {
    // description must come out a string: getDiscoveryKey() and the query
    // filter call .trim()/.toLowerCase() on it, so a non-string non-array bio
    // (user-controlled jsonb, e.g. `{}`) would otherwise 500 every catalog
    // listing — including unfiltered ones (#13637 class).
    const bio = Array.isArray(char.bio)
      ? char.bio.join(" ")
      : typeof char.bio === "string"
        ? char.bio
        : "";
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
  return { rows, truncated };
}

/** MCP twin of fetchLocalAgents: name-ordered prefix windows to `depth`. */
async function fetchLocalMcps(
  params: z.infer<typeof querySchema>,
  depth: number,
  appUrlEnv?: string,
): Promise<{ rows: DiscoveredService[]; truncated: boolean }> {
  const baseUrl = appUrlEnv || "https://cloud.eliza.app";
  const source = resolveDiscoverySource(baseUrl);

  let mcps: Awaited<ReturnType<typeof userMcpsService.listPublic>> = [];
  // See fetchLocalAgents: the extra row is what separates an exact fit from a
  // genuinely truncated scan.
  const probeDepth = depth + 1;
  for (let sourceOffset = 0; mcps.length < probeDepth; ) {
    const windowLimit = Math.min(
      probeDepth - mcps.length,
      REPOSITORY_WINDOW_CLAMP,
    );
    const page = await userMcpsService.listPublic({
      category: sqlCategory(params),
      search: params.query,
      limit: windowLimit,
      offset: sourceOffset,
      orderBy: "name",
    });
    mcps = mcps.concat(page);
    sourceOffset += page.length;
    if (page.length < windowLimit) break;
  }
  const truncated = mcps.length > depth;
  mcps = mcps.slice(0, depth);

  const rows = mcps.map(
    (mcp): DiscoveredService => ({
      id: mcp.id,
      name: mcp.name,
      description: mcp.description,
      type: "mcp",
      source,
      category: mcp.category,
      tags: mcp.tags ?? [],
      active: mcp.status === "live",
      mcpEndpoint: userMcpsService.getPublicProxyUrl(mcp, baseUrl),
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
                amountUsd: legacyMcpPointsToOrganizationCredits(
                  Number(mcp.credits_per_request),
                ),
                amountUnit: "legacy_mcp_pricing_points",
                currency: ORGANIZATION_CREDIT_UNIT,
                description: `$${legacyMcpPointsToOrganizationCredits(
                  Number(mcp.credits_per_request),
                )} in cloud credit per request`,
              }
            : {
                type: "x402",
                amount: Number(mcp.x402_price_usd),
                amountUsd: Number(mcp.x402_price_usd),
                amountUnit: "USD",
                currency: "USD",
                description: `$${mcp.x402_price_usd} per request`,
              },
    }),
  );
  return { rows, truncated };
}

export default app;
