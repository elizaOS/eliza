import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthWithOrg } from "@/lib/auth";
import { apiKeysService } from "@/lib/services/api-keys";

/**
 * GET /api/v1/api-keys
 * Lists all API keys for the authenticated user's organization.
 *
 * @returns Array of API key objects.
 */
export async function GET() {
  try {
    const user = await requireAuthWithOrg();

    const keys = await apiKeysService.listByOrganization(user.organization_id!);

    return NextResponse.json({ keys });
  } catch (error) {
    logger.error("Error fetching API keys:", error);
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/api-keys
 * Creates a new API key for the authenticated user's organization.
 *
 * @param request - Request body with name, optional description, permissions, rate_limit, and expires_at.
 * @returns Created API key details including the plain key (only shown once).
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAuthWithOrg();

    const body = await request.json();
    const { name, description, permissions, rate_limit, expires_at } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const { apiKey, plainKey } = await apiKeysService.create({
      name: name.trim(),
      description: description?.trim() || null,
      organization_id: user.organization_id!!,
      user_id: user.id,
      permissions: permissions || [],
      rate_limit: rate_limit || 1000,
      expires_at: expires_at ? new Date(expires_at) : null,
      is_active: true,
    });

    return NextResponse.json(
      {
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key_prefix: apiKey.key_prefix,
          created_at: apiKey.created_at,
          permissions: apiKey.permissions,
          rate_limit: apiKey.rate_limit,
          expires_at: apiKey.expires_at,
        },
        plainKey,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("Error creating API key:", error);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 },
    );
  }
}
