import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
async function __hono_GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!) : undefined;

    // Verify the app exists and belongs to the user's organization
    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return Response.json(
        {
          success: false,
          error: "App not found",
        },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return Response.json(
        {
          success: false,
          error: "Access denied",
        },
        { status: 403 },
      );
    }

    // Get app users
    const appUsers = await appsService.getAppUsers(id, limit);

    return Response.json({
      success: true,
      users: appUsers,
      pagination: {
        total: appUsers.length,
        limit: limit ?? appUsers.length,
      },
    });
  } catch (error) {
    logger.error("Failed to get app users:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get app users",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
