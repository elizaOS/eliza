/**
 * App managed-frontend hosting API
 *
 * GET  /api/v1/apps/:id/frontend  — list deployments + the active one
 * POST /api/v1/apps/:id/frontend  — publish a static site bundle (create → store
 *                                   in R2 → finalize → activate) in one call
 *
 * Managed frontend hosting is the seam that lets an app serve a first-class,
 * Cloud-hosted static site (with SEO + page analytics injected at the edge)
 * instead of only pointing at an external `app_url`. See
 * `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`.
 */

import { Hono } from "hono";
import { z } from "zod";
import { appFrontendDeploymentsRepository } from "@/db/repositories/app-frontend-deployments";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appFrontendHostingService } from "@/lib/services/app-frontend-hosting";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const FileSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  contentType: z.string().max(255).optional(),
});

const DeploySchema = z.object({
  files: z.array(FileSchema).min(1).max(2000),
  entrypoint: z.string().min(1).max(1024).optional(),
  spaFallback: z.boolean().optional(),
  activate: z.boolean().optional(),
  buildMeta: z
    .object({
      source: z.string().max(64).nullish(),
      framework: z.string().max(64).nullish(),
      gitCommit: z.string().max(128).nullish(),
      note: z.string().max(500).nullish(),
    })
    .optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing app id" }, 400);

    const found = await appsService.getById(id);
    if (!found) return c.json({ success: false, error: "App not found" }, 404);
    if (found.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const [deployments, active] = await Promise.all([
      appFrontendDeploymentsRepository.listByApp(id),
      appFrontendDeploymentsRepository.getActive(id),
    ]);
    return c.json({
      success: true,
      active_deployment_id: active?.id ?? null,
      deployments,
    });
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to list deployments:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing app id" }, 400);

    const found = await appsService.getById(id);
    if (!found) return c.json({ success: false, error: "App not found" }, 404);
    if (found.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const parsed = DeploySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const deployment = await appFrontendHostingService.deployBundle({
      app: { id: found.id, organization_id: found.organization_id },
      files: parsed.data.files,
      entrypoint: parsed.data.entrypoint,
      spaFallback: parsed.data.spaFallback,
      activate: parsed.data.activate,
      buildMeta: parsed.data.buildMeta ?? { source: "api" },
      createdByUserId: user.id,
    });

    logger.info("[Apps Frontend API] Published frontend deployment", {
      appId: id,
      deploymentId: deployment.id,
      version: deployment.version,
      files: deployment.file_count,
      bytes: deployment.total_bytes,
      active: deployment.status === "active",
    });

    return c.json({ success: true, deployment }, 201);
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to publish deployment:", error);
    return failureResponse(c, error);
  }
});

export default app;
