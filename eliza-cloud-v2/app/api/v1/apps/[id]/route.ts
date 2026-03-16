import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { appCleanupService } from "@/lib/services/app-cleanup";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

// Helper to allow empty strings (transform to null to clear) and omitted fields (undefined)
// - Omitted field → undefined (Drizzle skips, keeps old value)
// - Empty string "" → null (Drizzle sets NULL, clears the value)
// - Valid URL → the URL string
const optionalUrl = z.preprocess(
  (val) => (val === "" ? null : val),
  z.string().url().nullish(),
);

const optionalEmail = z.preprocess(
  (val) => (val === "" ? null : val),
  z.string().email().nullish(),
);

const UpdateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  app_url: optionalUrl,
  website_url: optionalUrl,
  contact_email: optionalEmail,
  allowed_origins: z.array(z.string()).optional(),
  logo_url: optionalUrl,
  is_active: z.boolean().optional(),
  linked_character_ids: z.array(z.string().uuid()).max(4).optional(),
});

/**
 * GET /api/v1/apps/[id]
 * Gets details for a specific app by ID.
 * Requires ownership verification.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the app ID.
 * @returns App details.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const app = await appsService.getById(id);

    if (!app) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (app.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    return NextResponse.json({ success: true, app });
  } catch (error) {
    logger.error("Failed to get app:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get app",
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/v1/apps/[id]
 * Updates an app's properties.
 * Requires ownership verification.
 *
 * @param request - Request body with optional fields to update.
 * @param params - Route parameters containing the app ID.
 * @returns Updated app details.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const validationResult = UpdateAppSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const updatedApp = await appsService.update(id, validationResult.data);

    logger.info(`Updated app: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
    });

    return NextResponse.json({ success: true, app: updatedApp });
  } catch (error) {
    logger.error("Failed to update app:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update app",
      },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/v1/apps/[id]
 * Partially updates an app's properties.
 * Requires ownership verification.
 * Same as PUT but explicitly named for partial updates.
 *
 * @param request - Request body with optional fields to update.
 * @param params - Route parameters containing the app ID.
 * @returns Updated app details.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const validationResult = UpdateAppSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const updatedApp = await appsService.update(id, validationResult.data);

    logger.info(`Patched app: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
      fields: Object.keys(validationResult.data),
    });

    return NextResponse.json({ success: true, app: updatedApp });
  } catch (error) {
    logger.error("Failed to patch app:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update app",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/v1/apps/[id]
 * Deletes an app and all its associated resources:
 * - Stops active sandboxes
 * - Removes Vercel domains and project
 * - Deletes GitHub repository
 * - Cleans up secret bindings
 * - Removes API key
 *
 * Requires ownership verification.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the app ID.
 * @returns Success status with cleanup details.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    // Parse optional query params for cleanup options
    const searchParams = request.nextUrl.searchParams;
    const deleteGitHubRepo = searchParams.get("deleteGitHubRepo") !== "false";
    const deleteVercelProject =
      searchParams.get("deleteVercelProject") !== "false";

    // Perform comprehensive cleanup and delete
    const cleanupResult = await appCleanupService.deleteAppWithCleanup(id, {
      deleteGitHubRepo,
      deleteVercelProject,
      continueOnError: true, // Always try to clean up as much as possible
    });

    logger.info(`Deleted app with cleanup: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
      cleaned: cleanupResult.cleaned,
      errors: cleanupResult.errors,
    });

    return NextResponse.json({
      success: cleanupResult.success,
      message: cleanupResult.success
        ? "App deleted successfully with all resources cleaned up"
        : "App deleted with some cleanup errors",
      cleaned: cleanupResult.cleaned,
      errors:
        cleanupResult.errors.length > 0 ? cleanupResult.errors : undefined,
    });
  } catch (error) {
    logger.error("Failed to delete app:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete app",
      },
      { status: 500 },
    );
  }
}
