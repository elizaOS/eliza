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
import { appsDeployOrganizationDecision } from "@/api-app/lib/apps-deploy-gate";
import { containersRepository } from "@/db/repositories/containers";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appDeploymentsService } from "@/lib/services/app-deployments";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { DeployBodySchema } from "./schema";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    // Product-2 container deploy is gated: until APPS_DEPLOY_ENABLED=1 on the
    // Worker, the deploy trigger isn't wired (bootstrap-app.ts), so creating a
    // deployment would flip the app to `building` with nothing to advance it —
    // a stranded app, no URL, no recovery (#8434). Fail clean with 503 instead.
    if (c.env.APPS_DEPLOY_ENABLED !== "1") {
      return c.json(
        {
          success: false,
          error: "App container deployment is not enabled",
          code: "apps_deploy_disabled",
        },
        503,
      );
    }
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
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const deployGate = appsDeployOrganizationDecision(
      c.env,
      user.organization_id,
    );
    if (!deployGate.allowed) {
      logger.warn("[Deploy POST] deployment blocked by production allowlist", {
        appId,
        userId: user.id,
        organizationId: user.organization_id,
        reason: deployGate.reason,
      });
      return c.json(
        {
          success: false,
          error: "App deploys are not enabled for this organization",
        },
        403,
      );
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

    // Per-org container quota precheck — give the user an immediate, clean 409
    // instead of queueing a deploy that fails ~30s later (the runner also
    // enforces this atomically via createWithQuotaCheck; this is the UX layer).
    const quota = await containersRepository.checkQuota(user.organization_id);
    if (!quota.allowed) {
      return c.json(
        {
          success: false,
          error: quota.error,
        },
        409,
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
