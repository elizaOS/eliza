/**
 * Owner preview of a managed frontend deployment.
 *
 * GET /api/v1/apps/:id/frontend/preview           — serve the active deployment root
 * GET /api/v1/apps/:id/frontend/preview/*         — serve any path in the deployment
 *   ?deployment=<id>  — preview a specific (e.g. not-yet-active) deployment
 *
 * Serves the site through the hosting service (SEO + beacon injected, SPA
 * fallback), records the page view server-side for document responses, and is
 * owner-scoped — the public, custom-domain serve path lives in the Worker entry.
 */

import { Hono } from "hono";
import { appFrontendDeploymentsRepository } from "@/db/repositories/app-frontend-deployments";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appFrontendHostingService } from "@/lib/services/app-frontend-hosting";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const PREVIEW_MARKER = "/frontend/preview";

const app = new Hono<AppEnv>();

app.get("*", async (c) => {
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

    const deploymentId = c.req.query("deployment");
    const deployment = deploymentId
      ? await appFrontendDeploymentsRepository.getByIdForApp(id, deploymentId)
      : await appFrontendDeploymentsRepository.getActive(id);
    if (!deployment) {
      return c.json(
        { success: false, error: "No frontend deployment to preview" },
        404,
      );
    }

    // Derive the site-relative path from the full URL (robust vs catch-all param naming).
    const url = new URL(c.req.url);
    const markerIdx = url.pathname.indexOf(PREVIEW_MARKER);
    const requestPath =
      markerIdx >= 0
        ? url.pathname.slice(markerIdx + PREVIEW_MARKER.length)
        : "/";

    const canonical = found.production_url || found.app_url;
    const rendered = await appFrontendHostingService.renderFrontendResponse({
      app: {
        id: found.id,
        name: found.name,
        description: found.description,
        logo_url: found.logo_url,
      },
      deployment,
      requestPath: requestPath || "/",
      seo: {
        title: found.name,
        description: found.description,
        image: found.logo_url,
        siteName: found.name,
        url: canonical,
      },
      siteBaseUrl: canonical || undefined,
    });

    // Record the page view server-side (no secret in the page). Best-effort:
    // telemetry must never break serving.
    if (rendered.isDocument) {
      const record = appsService
        .trackPageView(id, {
          pageUrl: requestPath || "/",
          referrer: c.req.header("referer") ?? "",
          ipAddress:
            c.req.header("cf-connecting-ip") ||
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
            "unknown",
          userAgent: c.req.header("user-agent") ?? "unknown",
          source: "hosted_frontend_preview",
          metadata: { deploymentId: deployment.id },
        })
        .catch((error) =>
          logger.warn("[Apps Frontend API] page-view record failed", {
            appId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // `c.executionCtx` is a getter that throws outside a Worker (e.g. tests);
      // the record promise already runs, waitUntil only extends the isolate.
      try {
        c.executionCtx.waitUntil(record);
      } catch {
        // no Worker execution context — nothing to keep alive.
      }
    }

    return new Response(rendered.body, {
      status: rendered.status,
      headers: rendered.headers,
    });
  } catch (error) {
    logger.error("[Apps Frontend API] Failed to serve preview:", error);
    return failureResponse(c, error);
  }
});

export default app;
