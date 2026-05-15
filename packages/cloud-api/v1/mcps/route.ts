/**
 * GET/POST /api/v1/mcps
 * CRUD endpoints for user-created MCP servers (monetization via credits or
 * x402).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
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

const listMcpsSchema = z.object({
  category: z.string().max(30).optional(),
  search: z.string().max(100).optional(),
  status: z.enum(["draft", "pending_review", "live", "suspended", "deprecated"]).optional(),
  scope: z.enum(["own", "public", "all"]).optional().default("own"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
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
      return c.json({ error: "containerId is required for container MCPs" }, 400);
    }
    if (data.endpointType === "external" && !data.externalEndpoint) {
      return c.json({ error: "externalEndpoint is required for external MCPs" }, 400);
    }
    if (data.endpointType === "external" && data.externalEndpoint) {
      try {
        await assertSafeOutboundUrl(data.externalEndpoint);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Unsafe external endpoint" },
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
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const params = Object.fromEntries(new URL(c.req.url).searchParams);
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

    const { category, search, status, scope, limit, offset } = validation.data;

    let mcps;

    if (scope === "public") {
      mcps = await userMcpsService.listPublic({ category, search, limit, offset });
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
      mcps = [...ownMcps, ...publicMcps.filter((m) => !ownIds.has(m.id))];
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
