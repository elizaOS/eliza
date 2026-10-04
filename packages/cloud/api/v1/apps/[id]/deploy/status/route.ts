/**
 * GET /api/v1/apps/:id/deploy/status
 *
 * Returns the latest deployment record for the app. Polled by the
 * `elizaos deploy` CLI (PR #7786) every ~5s until status is READY or
 * ERROR (10-minute cap on the CLI side).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import { appDeploymentsService } from "@elizaos/cloud-shared/lib/services/app-deployments";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) {
      return c.json({ success: false, error: "Missing app id" }, 400);
    }

    const appRow = await appsService.getById(appId);
    if (!appRow) {
      return c.json({ success: false, error: "App not found" }, 404);
    }
    if (appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const record = await appDeploymentsService.getLatestDeployment(appId);
    if (!record) {
      return c.json({
        success: true,
        deploymentId: null,
        status: "DRAFT" as const,
        vercelUrl: null,
        error: null,
        startedAt: null,
      });
    }

    return c.json({
      success: true,
      deploymentId: record.deploymentId,
      status: record.status,
      vercelUrl: record.vercelUrl,
      error: record.error,
      startedAt: record.startedAt,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
