import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { appCreditsService } from "@/lib/services/app-credits";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

const UpdateMonetizationSchema = z.object({
  monetizationEnabled: z.boolean().optional(),
  inferenceMarkupPercentage: z.number().min(0).max(1000).optional(),
  purchaseSharePercentage: z.number().min(0).max(100).optional(),
});

/**
 * GET /api/v1/apps/[id]/monetization
 * Gets monetization settings for a specific app.
 * Requires ownership verification.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the app ID.
 * @returns Monetization settings including markup percentages and enabled status.
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

    const settings = await appCreditsService.getMonetizationSettings(id);

    return NextResponse.json({ success: true, monetization: settings });
  } catch (error) {
    logger.error("Failed to get monetization settings:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get monetization settings",
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/v1/apps/[id]/monetization
 * Updates monetization settings for a specific app.
 * Requires ownership verification.
 *
 * Request Body (all fields optional):
 * - `monetizationEnabled`: Boolean to enable/disable monetization.
 * - `inferenceMarkupPercentage`: Percentage markup for inference calls (0-1000).
 * - `purchaseSharePercentage`: Percentage share of credit purchases (0-100).
 *
 * @param request - Request body with monetization settings to update.
 * @param params - Route parameters containing the app ID.
 * @returns Updated monetization settings.
 */
export async function PUT(
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

    const body = await request.json();
    const validationResult = UpdateMonetizationSchema.safeParse(body);

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

    await appCreditsService.updateMonetizationSettings(
      id,
      validationResult.data,
    );
    const updatedSettings = await appCreditsService.getMonetizationSettings(id);

    logger.info(`Updated monetization settings for app: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
    });

    return NextResponse.json({ success: true, monetization: updatedSettings });
  } catch (error) {
    logger.error("Failed to update monetization settings:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update monetization settings",
      },
      { status: 500 },
    );
  }
}
