import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * MCP Publish/Unpublish API
 *
 * POST /api/v1/mcps/[mcpId]/publish - Publish MCP (make live)
 * DELETE /api/v1/mcps/[mcpId]/publish - Unpublish MCP (back to draft)
 */

import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";

/**
 * POST /api/v1/mcps/[mcpId]/publish
 * Publish MCP (make it live and discoverable)
 */
async function __hono_POST(request: Request, ctx: { params: Promise<{ mcpId: string }> }) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const mcp = await userMcpsService.publish(mcpId, authResult.user.organization_id);

  logger.info("[API] Published user MCP", {
    id: mcpId,
    name: mcp.name,
    userId: authResult.user.id,
  });

  return Response.json({
    mcp,
    message: "MCP published successfully. It is now discoverable in the registry.",
  });
}

/**
 * DELETE /api/v1/mcps/[mcpId]/publish
 * Unpublish MCP (back to draft)
 */
async function __hono_DELETE(request: Request, ctx: { params: Promise<{ mcpId: string }> }) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const mcp = await userMcpsService.unpublish(mcpId, authResult.user.organization_id);

  logger.info("[API] Unpublished user MCP", {
    id: mcpId,
    userId: authResult.user.id,
  });

  return Response.json({
    mcp,
    message: "MCP unpublished. It is no longer discoverable in the registry.",
  });
}

/**
 * OPTIONS handler for CORS
 */
async function __hono_OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ mcpId: c.req.param("mcpId")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ mcpId: c.req.param("mcpId")! }) }),
);
export default __hono_app;
