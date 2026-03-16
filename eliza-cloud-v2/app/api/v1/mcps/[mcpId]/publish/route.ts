/**
 * MCP Publish/Unpublish API
 *
 * POST /api/v1/mcps/[mcpId]/publish - Publish MCP (make live)
 * DELETE /api/v1/mcps/[mcpId]/publish - Unpublish MCP (back to draft)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/mcps/[mcpId]/publish
 * Publish MCP (make it live and discoverable)
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ mcpId: string }> },
) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const mcp = await userMcpsService.publish(
    mcpId,
    authResult.user.organization_id,
  );

  logger.info("[API] Published user MCP", {
    id: mcpId,
    name: mcp.name,
    userId: authResult.user.id,
  });

  return NextResponse.json({
    mcp,
    message:
      "MCP published successfully. It is now discoverable in the registry.",
  });
}

/**
 * DELETE /api/v1/mcps/[mcpId]/publish
 * Unpublish MCP (back to draft)
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ mcpId: string }> },
) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);
  const { mcpId } = await ctx.params;

  const mcp = await userMcpsService.unpublish(
    mcpId,
    authResult.user.organization_id,
  );

  logger.info("[API] Unpublished user MCP", {
    id: mcpId,
    userId: authResult.user.id,
  });

  return NextResponse.json({
    mcp,
    message: "MCP unpublished. It is no longer discoverable in the registry.",
  });
}

/**
 * OPTIONS handler for CORS
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
