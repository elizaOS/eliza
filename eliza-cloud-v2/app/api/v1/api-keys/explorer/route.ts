import { NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthWithOrg } from "@/lib/auth";
import { apiKeysService } from "@/lib/services/api-keys";

const EXPLORER_KEY_NAME = "API Explorer Key";

/**
 * GET /api/v1/api-keys/explorer
 *
 * Gets or creates an API key specifically for the API Explorer page.
 * This key bills to the user's organization account and is used for
 * testing API endpoints in the explorer.
 *
 * The key is automatically created if it doesn't exist, ensuring
 * a seamless experience for users testing APIs.
 */
export async function GET() {
  try {
    const user = await requireAuthWithOrg();

    // Check if user already has an explorer key
    const existingKeys = await apiKeysService.listByOrganization(
      user.organization_id,
    );

    const explorerKey = existingKeys.find(
      (key) => key.name === EXPLORER_KEY_NAME && key.user_id === user.id,
    );

    if (explorerKey) {
      // Return existing key info (we can't return the plain key for existing keys)
      // But we stored the full key in the database, so we can return it
      return NextResponse.json({
        apiKey: {
          id: explorerKey.id,
          name: explorerKey.name,
          description: explorerKey.description,
          key_prefix: explorerKey.key_prefix,
          key: explorerKey.key, // Return the full key for explorer use
          created_at: explorerKey.created_at,
          is_active: explorerKey.is_active,
          usage_count: explorerKey.usage_count,
          last_used_at: explorerKey.last_used_at,
        },
        isNew: false,
      });
    }

    // Create a new explorer key for this user
    const { apiKey, plainKey } = await apiKeysService.create({
      name: EXPLORER_KEY_NAME,
      description:
        "Auto-generated key for testing APIs in the API Explorer. Usage is billed to your account.",
      organization_id: user.organization_id,
      user_id: user.id,
      permissions: [], // Full permissions for explorer testing
      rate_limit: 100, // Reasonable rate limit for testing
      expires_at: null, // No expiration
      is_active: true,
    });

    return NextResponse.json(
      {
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key_prefix: apiKey.key_prefix,
          key: plainKey, // Return the full plain key for new keys
          created_at: apiKey.created_at,
          is_active: apiKey.is_active,
          usage_count: 0,
          last_used_at: null,
        },
        isNew: true,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("Error getting/creating explorer API key:", error);

    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json(
        { error: "Please sign in to use the API Explorer" },
        { status: 401 },
      );
    }

    if (error instanceof Error && error.message.includes("Forbidden")) {
      return NextResponse.json(
        { error: "Please complete your account setup to use the API Explorer" },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: "Failed to get API key for explorer" },
      { status: 500 },
    );
  }
}
