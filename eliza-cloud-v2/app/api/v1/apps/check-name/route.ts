import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

const CheckNameSchema = z.object({
  name: z.string().min(1).max(100),
});

/**
 * POST /api/v1/apps/check-name
 * Checks if an app name is available for use.
 * Returns availability status and suggested alternatives if unavailable.
 *
 * @param request - Request body with { name: string }
 * @returns { available: boolean, slug: string, conflictType?: string, suggestedName?: string }
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuthOrApiKeyWithOrg(request);

    const body = await request.json();
    const validationResult = CheckNameSchema.safeParse(body);

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

    const { name } = validationResult.data;
    const result = await appsService.isNameAvailable(name);

    logger.debug("App name availability check", {
      name,
      available: result.available,
      slug: result.slug,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("Failed to check app name:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to check app name",
      },
      { status: 500 },
    );
  }
}
