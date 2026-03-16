import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/v1/apps/[id]/users
 * Gets a list of users who have interacted with a specific app.
 * Supports pagination via limit query parameter. Requires ownership verification.
 *
 * Query Parameters:
 * - `limit`: Maximum number of users to return.
 *
 * @param request - Request with optional limit query parameter.
 * @param params - Route parameters containing the app ID.
 * @returns List of app users with pagination information.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit")
      ? parseInt(searchParams.get("limit")!)
      : undefined;

    // Verify the app exists and belongs to the user's organization
    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return NextResponse.json(
        {
          success: false,
          error: "App not found",
        },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied",
        },
        { status: 403 },
      );
    }

    // Get app users
    const appUsers = await appsService.getAppUsers(id, limit);

    return NextResponse.json({
      success: true,
      users: appUsers,
      pagination: {
        total: appUsers.length,
        limit: limit ?? appUsers.length,
      },
    });
  } catch (error) {
    logger.error("Failed to get app users:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get app users",
      },
      { status: 500 },
    );
  }
}
