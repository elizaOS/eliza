/**
 * POST /api/v1/apps/:id/deploy
 *
 * Kicks off a deploy for the app. Body is fully optional — defaults pull
 * from the app's linked GitHub repo and stored env config:
 *
 *   { repoUrl?: string; ref?: string; dockerfile?: string;
 *     env?: Record<string, string> }
 *
 * Completes the cloud half of `elizaos deploy` (PR #7786). The CLI keel
 * from that PR drives this endpoint: build → upload → POST here →
 * attach domain → poll GET /deploy/status until READY or ERROR.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appDeploymentsService } from "@/lib/services/app-deployments";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { DeployBodySchema } from "./schema";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
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
      // 403 — the caller is authed but not the owning org.
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    // Body is fully optional — accept an empty/absent body as `{}`.
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const parsed = DeployBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request body",
        },
        400,
      );
    }

    const record = await appDeploymentsService.createDeployment({
      appId,
      organizationId: user.organization_id,
      userId: user.id,
      ...parsed.data,
    });

    logger.info("[Deploy POST] deployment queued", {
      appId,
      deploymentId: record.deploymentId,
      userId: user.id,
      organizationId: user.organization_id,
    });

    return c.json(
      {
        success: true,
        deploymentId: record.deploymentId,
        status: record.status,
        startedAt: record.startedAt,
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
