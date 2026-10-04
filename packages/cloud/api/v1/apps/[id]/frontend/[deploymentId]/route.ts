/**
 * App frontend deployment detail
 *
 * GET    /api/v1/apps/:id/frontend/:deploymentId  — fetch one deployment
 * DELETE /api/v1/apps/:id/frontend/:deploymentId  — delete a non-active deployment
 *                                                   (and its R2 artifacts)
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { appFrontendDeploymentsRepository } from "@elizaos/cloud-shared/db/repositories/app-frontend-deployments";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import { appFrontendHostingService } from "@elizaos/cloud-shared/lib/services/app-frontend-hosting";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
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

    const deployment = await appFrontendDeploymentsRepository.getByIdForApp(
      id,
      deploymentId,
    );
    if (!deployment)
      return c.json({ success: false, error: "Deployment not found" }, 404);
    return c.json({ success: true, deployment });
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to get deployment:", error);
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
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

    const deployment = await appFrontendDeploymentsRepository.getByIdForApp(
      id,
      deploymentId,
    );
    if (!deployment)
      return c.json({ success: false, error: "Deployment not found" }, 404);
    if (deployment.status === "active") {
      return c.json(
        {
          success: false,
          error: "Cannot delete the active deployment; activate another first",
        },
        409,
      );
    }

    await appFrontendHostingService.deleteArtifacts(deployment);
    await appFrontendDeploymentsRepository.delete(deployment.id);

    logger.info("[Apps Frontend API] Deleted frontend deployment", {
      appId: id,
      deploymentId,
    });
    return c.json({ success: true });
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to delete deployment:", error);
    return failureResponse(c, error);
  }
});

export default app;
