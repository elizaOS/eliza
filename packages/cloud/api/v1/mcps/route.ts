/**
 * GET/POST /api/v1/mcps
 * CRUD endpoints for user-created MCP servers (monetization via credits or
 * x402).
 */

import { isIP } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { isForbiddenIpAddress } from "@/lib/security/outbound-url";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const createMcpSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().min(1).max(1000),
  category: z
    .enum([
      "utilities",
      "finance",
      "data",
      "communication",
      "productivity",
      "ai",
      "search",
      "platform",
      "other",
    ])
    .optional(),
  endpointType: z.enum(["container", "external"]).optional(),
  containerId: z.string().uuid().optional(),
  externalEndpoint: z.string().url().optional(),
  endpointPath: z.string().max(100).optional(),
  transportType: z.enum(["streamable-http", "stdio"]).optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(50),
        description: z.string().min(1).max(500),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        cost: z.string().max(20).optional(),
      }),
    )
    .max(50)
    .optional(),
  pricingType: z.enum(["free", "credits", "x402"]).optional(),
  creditsPerRequest: z.number().min(0).max(1000).optional(),
  x402PriceUsd: z.number().min(0).max(100).optional(),
  x402Enabled: z.boolean().optional(),
  creatorSharePercentage: z.number().min(0).max(100).optional(),
  documentationUrl: z.string().url().optional(),
  sourceCodeUrl: z.string().url().optional(),
  supportEmail: z.string().email().optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  icon: z.string().max(30).optional(),
  color: z.string().max(10).optional(),
});

const DEFAULT_MCPS_LIST_LIMIT = 50;
const MAX_MCPS_LIST_LIMIT = 100;

class McpsListLimitError extends Error {
  constructor(message = "Invalid limit") {
    super(message);
    this.name = "McpsListLimitError";
  }
}

/**
 * GET /api/v1/mcps `limit` is user-MCP catalog page size identity,
 * leftover tax after plugin-mcp marketplace / cloud MCP search.
 * Stock develop used z.coerce.number(), which treated `1e2` / `007` /
 * `0x10` as a page size instead of a 400. offset / category / search /
 * status / scope stay untouched. Missing / empty still means 50.
 * Exact integers clamp at 100.
 */
function parseMcpsListLimitQuery(searchParams: URLSearchParams): number {
  const requested = searchParams.getAll("limit");
  if (requested.length > 1) {
    throw new McpsListLimitError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return DEFAULT_MCPS_LIST_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new McpsListLimitError();
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new McpsListLimitError();
  }
  return Math.min(parsed, MAX_MCPS_LIST_LIMIT);
}

const listMcpsSchema = z.object({
  category: z.string().max(30).optional(),
  search: z.string().max(100).optional(),
  status: z
    .enum(["draft", "pending_review", "live", "suspended", "deprecated"])
    .optional(),
  scope: z.enum(["own", "public", "all"]).optional().default("own"),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const validation = createMcpSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    const data = validation.data;

    if (data.endpointType === "container" && !data.containerId) {
      return c.json(
        { error: "containerId is required for container MCPs" },
        400,
      );
    }
    if (data.endpointType === "external" && !data.externalEndpoint) {
      return c.json(
        { error: "externalEndpoint is required for external MCPs" },
        400,
      );
    }
    if (data.endpointType === "external" && data.externalEndpoint) {
      // SSRF guard at registration is synchronous only: require https and
      // reject private/loopback IP-literal targets. We do NOT resolve DNS here
      // (a momentarily-unresolvable host must not block registration, and the
      // Worker runtime is not a reliable place for outbound DNS). Full
      // DNS-based SSRF enforcement runs at proxy/fetch time in
      // mcp/proxy/[mcpId] via assertSafeOutboundUrl.
      let parsedEndpoint: URL;
      try {
        parsedEndpoint = new URL(data.externalEndpoint);
      } catch {
        return c.json({ error: "Invalid external endpoint URL" }, 400);
      }
      if (parsedEndpoint.protocol !== "https:") {
        return c.json({ error: "External endpoint must use https" }, 400);
      }
      const endpointHost = parsedEndpoint.hostname
        .replace(/^\[/, "")
        .replace(/\]$/, "");
      if (isIP(endpointHost) && isForbiddenIpAddress(endpointHost)) {
        return c.json(
          { error: "External endpoint must not target a private address" },
          400,
        );
      }
    }

    const mcp = await userMcpsService.create({
      ...data,
      organizationId: user.organization_id,
      userId: user.id,
    });

    logger.info("[API] Created user MCP", {
      id: mcp.id,
      name: mcp.name,
      userId: user.id,
    });

    return c.json({ mcp }, 201);
  } catch (error) {
    // MCP create path currently 500s in the cloud-api e2e because the user_mcps table
    // exists — migration 0147 applies — but the worker INSERT fails against
    // PGlite with a "Broken pipe" connection error). Log the real cause so the
    // next run / prod (Railway) hit is debuggable instead of an opaque 500.
    logger.error("[API] Failed to create user MCP", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const searchParams = new URL(c.req.url).searchParams;
    let limit: number;
    try {
      limit = parseMcpsListLimitQuery(searchParams);
    } catch (limitError) {
      if (limitError instanceof McpsListLimitError) {
        return c.json({ error: limitError.message }, 400);
      }
      throw limitError;
    }
    const params = Object.fromEntries(searchParams);
    delete params.limit;
    const validation = listMcpsSchema.safeParse(params);

    if (!validation.success) {
      return c.json(
        {
          error: "Invalid query parameters",
          details: validation.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    const { category, search, status, scope, offset } = validation.data;

    // Public (foreign) MCPs are redacted — no raw external_endpoint (metered-proxy
    // bypass) and no created_by_user_id (cross-org user identity). The caller's
    // OWN MCPs are returned in full. (#10918)
    type ListedMcp =
      | Awaited<ReturnType<typeof userMcpsService.listPublic>>[number]
      | ReturnType<typeof userMcpsService.toPublicMcp>;
    let mcps: ListedMcp[];

    if (scope === "public") {
      const publicMcps = await userMcpsService.listPublic({
        category,
        search,
        limit,
        offset,
      });
      mcps = publicMcps.map((m) =>
        userMcpsService.toVisibleMcpForOrganization(m, user.organization_id),
      );
    } else if (scope === "own") {
      mcps = await userMcpsService.listByOrganization(user.organization_id, {
        status,
        limit,
        offset,
      });
    } else {
      const [ownMcps, publicMcps] = await Promise.all([
        userMcpsService.listByOrganization(user.organization_id, {
          status,
          limit: Math.ceil(limit / 2),
          offset: 0,
        }),
        userMcpsService.listPublic({
          category,
          search,
          limit: Math.floor(limit / 2),
          offset: 0,
        }),
      ]);

      const ownIds = new Set(ownMcps.map((m) => m.id));
      mcps = [
        ...ownMcps,
        ...publicMcps
          .filter((m) => !ownIds.has(m.id))
          .map((m) => userMcpsService.toPublicMcp(m)),
      ];
    }

    return c.json({
      mcps,
      total: mcps.length,
      scope,
      filters: { category, search, status },
      pagination: { limit, offset },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
