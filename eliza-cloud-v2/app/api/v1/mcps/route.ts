/**
 * User MCPs API
 *
 * CRUD endpoints for user-created MCP servers.
 * Supports monetization via credits or x402.
 *
 * POST /api/v1/mcps - Create a new MCP
 * GET /api/v1/mcps - List MCPs (own or public)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

// ============================================================================
// Schemas
// ============================================================================

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
  transportType: z.enum(["http", "sse", "streamable-http"]).optional(),
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
  status: z
    .enum(["draft", "pending_review", "live", "suspended", "deprecated"])
    .optional(),
  scope: z.enum(["own", "public", "all"]).optional().default("own"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/v1/mcps
 * Create a new MCP server
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);

  const body = await request.json();
  const validation = createMcpSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
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

  const data = validation.data;

  // Validate endpoint type requirements
  if (data.endpointType === "container" && !data.containerId) {
    return NextResponse.json(
      { error: "containerId is required for container MCPs" },
      { status: 400 },
    );
  }
  if (data.endpointType === "external" && !data.externalEndpoint) {
    return NextResponse.json(
      { error: "externalEndpoint is required for external MCPs" },
      { status: 400 },
    );
  }

  const mcp = await userMcpsService.create({
    ...data,
    organizationId: authResult.user.organization_id,
    userId: authResult.user.id,
  });

  logger.info("[API] Created user MCP", {
    id: mcp.id,
    name: mcp.name,
    userId: authResult.user.id,
  });

  return NextResponse.json({ mcp }, { status: 201 });
}

/**
 * GET /api/v1/mcps
 * List MCPs (own, public, or all)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuthOrApiKeyWithOrg(request);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const validation = listMcpsSchema.safeParse(params);

  if (!validation.success) {
    return NextResponse.json(
      {
        error: "Invalid query parameters",
        details: validation.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const { category, search, status, scope, limit, offset } = validation.data;

  let mcps;

  if (scope === "public") {
    // List public MCPs from all users
    mcps = await userMcpsService.listPublic({
      category,
      search,
      limit,
      offset,
    });
  } else if (scope === "own") {
    // List user's own MCPs
    mcps = await userMcpsService.listByOrganization(
      authResult.user.organization_id,
      { status, limit, offset },
    );
  } else {
    // List all (own + public)
    const [ownMcps, publicMcps] = await Promise.all([
      userMcpsService.listByOrganization(authResult.user.organization_id, {
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

    // Dedupe and combine
    const ownIds = new Set(ownMcps.map((m) => m.id));
    mcps = [...ownMcps, ...publicMcps.filter((m) => !ownIds.has(m.id))];
  }

  return NextResponse.json({
    mcps,
    total: mcps.length,
    scope,
    filters: { category, search, status },
    pagination: { limit, offset },
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
