import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Individual User MCP API
 *
 * GET /api/v1/mcps/[mcpId] - Get MCP details
 * PUT /api/v1/mcps/[mcpId] - Update MCP
 * DELETE /api/v1/mcps/[mcpId] - Delete MCP
 */

import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// Schemas
// ============================================================================

const updateMcpSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000).optional(),
  version: z.string().max(20).optional(),
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
  documentationUrl: z.string().url().nullable().optional(),
  sourceCodeUrl: z.string().url().nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  icon: z.string().max(30).optional(),
  color: z.string().max(10).optional(),
  isPublic: z.boolean().optional(),
});

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/v1/mcps/[mcpId]
 * Get MCP details
 */
async function __hono_GET(request: Request, ctx: { params: Promise<{ mcpId: string }> }) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const mcp = await userMcpsService.getById(mcpId);

  if (!mcp) {
    return Response.json({ error: "MCP not found" }, { status: 404 });
  }

  // Check access - owner can see all, others can only see public
  if (mcp.organization_id !== authResult.user.organization_id && !mcp.is_public) {
    return Response.json({ error: "MCP not found" }, { status: 404 });
  }

  // Get stats if owner
  let stats = null;
  if (mcp.organization_id === authResult.user.organization_id) {
    stats = await userMcpsService.getStats(mcpId, mcp.organization_id);
  }

  // Get endpoint URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const endpointUrl = userMcpsService.getEndpointUrl(mcp, baseUrl);

  return Response.json({
    mcp: {
      ...mcp,
      endpointUrl,
    },
    stats,
    isOwner: mcp.organization_id === authResult.user.organization_id,
  });
}

/**
 * PUT /api/v1/mcps/[mcpId]
 * Update MCP
 */
async function __hono_PUT(request: Request, ctx: { params: Promise<{ mcpId: string }> }) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const body = await request.json();
  const validation = updateMcpSchema.safeParse(body);

  if (!validation.success) {
    return Response.json(
      {
        error: "Invalid request body",
        details: validation.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const mcp = await userMcpsService.update(mcpId, authResult.user.organization_id, validation.data);

  logger.info("[API] Updated user MCP", {
    id: mcpId,
    userId: authResult.user.id,
  });

  return Response.json({ mcp });
}

/**
 * DELETE /api/v1/mcps/[mcpId]
 * Delete MCP
 */
async function __hono_DELETE(request: Request, ctx: { params: Promise<{ mcpId: string }> }) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  await userMcpsService.delete(mcpId, authResult.user.organization_id);

  logger.info("[API] Deleted user MCP", {
    id: mcpId,
    userId: authResult.user.id,
  });

  return Response.json({ success: true });
}

/**
 * OPTIONS handler for CORS
 */
async function __hono_OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ mcpId: c.req.param("mcpId")! }) }),
);
__hono_app.put("/", async (c) =>
  __hono_PUT(c.req.raw, { params: Promise.resolve({ mcpId: c.req.param("mcpId")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ mcpId: c.req.param("mcpId")! }) }),
);
export default __hono_app;
