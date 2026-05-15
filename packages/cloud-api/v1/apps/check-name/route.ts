/**
 * POST /api/v1/apps/check-name — check if an app name is available.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckNameSchema = z.object({
  name: z.string().min(1).max(100),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const validationResult = CheckNameSchema.safeParse(body);

    if (!validationResult.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        400,
      );
    }

    const { name } = validationResult.data;
    const result = await appsService.isNameAvailable(name);

    logger.debug("[Apps API] App name availability check", {
      name,
      available: result.available,
      slug: result.slug,
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[Apps API] Failed to check app name:", error);
    return failureResponse(c, error);
  }
});

export default app;
