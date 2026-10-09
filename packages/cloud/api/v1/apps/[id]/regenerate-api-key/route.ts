// Handles v1 cloud API v1 apps id regenerate api key route traffic with route-local auth expectations.

import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import { isAppKeyOutOfScope } from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

async function handlePOST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!context) {
    return Response.json(
      { success: false, error: "Missing route parameters" },
      { status: 400 },
    );
  }
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;

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
    // An app-scoped API key may only rotate its OWN app's key, never a sibling's
    // (#10852) — otherwise App A's key could DoS App B by rotating B's key.
    if (await isAppKeyOutOfScope(apiKey?.id, id)) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    const newApiKey = await appsService.regenerateApiKey(id);

    logger.info(`Regenerated API key for app: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
    });

    return Response.json({
      success: true,
      apiKey: newApiKey,
      message:
        "API key regenerated successfully. Make sure to save it securely.",
    });
  } catch (error) {
    logger.error("Failed to regenerate API key:", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to regenerate API key",
      },
      { status: 500 },
    );
  }
}

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) =>
  handlePOST(c.req.raw, {
    params: Promise.resolve({
      id: c.req.param("id")!,
    }),
  }),
);

export default app;
