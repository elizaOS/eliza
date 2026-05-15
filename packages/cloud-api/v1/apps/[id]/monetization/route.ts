import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
async function __hono_GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const app = await appsService.getById(id);

    if (!app) {
      return Response.json({ success: false, error: "App not found" }, { status: 404 });
    }

    if (app.organization_id !== user.organization_id) {
      return Response.json({ success: false, error: "Access denied" }, { status: 403 });
    }

    const settings = await appCreditsService.getMonetizationSettings(id);

    return Response.json({ success: true, monetization: settings });
  } catch (error) {
    logger.error("Failed to get monetization settings:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get monetization settings",
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
async function __hono_PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const app = await appsService.getById(id);

    if (!app) {
      return Response.json({ success: false, error: "App not found" }, { status: 404 });
    }

    if (app.organization_id !== user.organization_id) {
      return Response.json({ success: false, error: "Access denied" }, { status: 403 });
    }

    const body = await request.json();
    const validationResult = UpdateMonetizationSchema.safeParse(body);

    if (!validationResult.success) {
      return Response.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    await appCreditsService.updateMonetizationSettings(id, validationResult.data);
    const updatedSettings = await appCreditsService.getMonetizationSettings(id);

    logger.info(`Updated monetization settings for app: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
    });

    return Response.json({ success: true, monetization: updatedSettings });
  } catch (error) {
    logger.error("Failed to update monetization settings:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update monetization settings",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.put("/", async (c) =>
  __hono_PUT(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
