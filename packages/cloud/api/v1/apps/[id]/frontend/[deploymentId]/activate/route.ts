/**
 * Activate a frontend deployment (this is also the rollback primitive).
 *
 * POST /api/v1/apps/:id/frontend/:deploymentId/activate
 *
 * Atomically makes the target deployment the single active one, demoting the
 * previous active to `superseded`. Activating an older deployment is a rollback.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import { appFrontendHostingService } from "@elizaos/cloud-shared/lib/services/app-frontend-hosting";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    const deploymentId = c.req.param("deploymentId");
    if (!id || !deploymentId) {
      return c.json(
        { success: false, error: "Missing app id or deployment id" },
        400,
      );
    }

    const found = await appsService.getById(id);
    if (!found) return c.json({ success: false, error: "App not found" }, 404);
    if (found.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const activated = await appFrontendHostingService.activate(
      id,
      deploymentId,
    );
    if (!activated)
      return c.json({ success: false, error: "Deployment not found" }, 404);

    logger.info("[Apps Frontend API] Activated frontend deployment", {
      appId: id,
      deploymentId,
      version: activated.version,
    });
    return c.json({ success: true, deployment: activated });
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to activate deployment:", error);
    return failureResponse(c, error);
  }
});

export default app;
