/**
 * Public hosted-frontend serve path.
 *
 * GET /api/v1/hosted-frontend/serve/*?host=<hostname>
 *
 * Serves an app's ACTIVE managed frontend deployment from R2 for public
 * visitors, resolving the app from the requesting host:
 *   - `<slug>.<ELIZA_FRONTEND_HOST_SUFFIX>`  → app by slug (system host), or
 *   - a verified, active managed custom domain → its bound app (mirrors the
 *     reviewed predicate in `/api/v1/domains/resolve`).
 *
 * SEO + a page-view beacon are injected into the document at response time and
 * the page view is recorded server-side (no secret embedded). Fails CLOSED:
 * any unresolved host or missing deployment → 404. Public + read-only.
 *
 * The Worker entry rewrites system-frontend-host traffic to this route (see
 * `getHostedFrontendServeRewrite` in `src/index.ts`); custom domains reach it
 * once their DNS points at the Worker.
 */

import { Hono } from "hono";
import { appFrontendDeploymentsRepository } from "@/db/repositories/app-frontend-deployments";
import { appFrontendHostingService } from "@/lib/services/app-frontend-hosting";
import { appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const SERVE_MARKER = "/hosted-frontend/serve";

function normalizeHost(host: string | undefined): string | null {
  const normalized = host?.trim().toLowerCase().replace(/\.+$/, "").split(":")[0];
  return normalized && normalized.length > 0 ? normalized : null;
}

async function resolveAppForHost(host: string) {
  const suffixRaw = getCloudAwareEnv().ELIZA_FRONTEND_HOST_SUFFIX;
  const suffix = suffixRaw ? String(suffixRaw).trim().toLowerCase().replace(/^\.+/, "") : null;
  if (suffix && host.endsWith(`.${suffix}`)) {
    const slug = host.slice(0, host.length - suffix.length - 1);
    if (slug) {
      const app = await appsService.getBySlug(slug);
      if (app?.is_active) return app;
    }
  }
  // Verified, active custom domain → its app (same predicate as /domains/resolve).
  const managedDomain = await managedDomainsService.getDomainByName(host);
  if (managedDomain?.appId && managedDomain.verified && managedDomain.status === "active") {
    const app = await appsService.getById(managedDomain.appId);
    if (app?.is_active && app.is_approved) return app;
  }
  return null;
}

const app = new Hono<AppEnv>();

app.get("*", async (c) => {
  try {
    const url = new URL(c.req.url);
    const host = normalizeHost(c.req.query("host") ?? c.req.header("x-forwarded-host") ?? url.hostname);
    if (!host) return c.text("Not Found", 404);

    const appRow = await resolveAppForHost(host);
    if (!appRow) return c.text("Not Found", 404);

    const deployment = await appFrontendDeploymentsRepository.getActive(appRow.id);
    if (!deployment) return c.text("Not Found", 404);

    const markerIdx = url.pathname.indexOf(SERVE_MARKER);
    const requestPath = markerIdx >= 0 ? url.pathname.slice(markerIdx + SERVE_MARKER.length) : "/";

    const canonicalBase = `https://${host}`;
    const rendered = await appFrontendHostingService.renderFrontendResponse({
      app: {
        id: appRow.id,
        name: appRow.name,
        description: appRow.description,
        logo_url: appRow.logo_url,
      },
      deployment,
      requestPath: requestPath || "/",
      seo: {
        title: appRow.name,
        description: appRow.description,
        image: appRow.logo_url,
        siteName: appRow.name,
        url: `${canonicalBase}${requestPath || "/"}`,
      },
      beaconBase: canonicalBase,
    });

    if (rendered.isDocument) {
      const record = appsService
        .trackPageView(appRow.id, {
          pageUrl: requestPath || "/",
          referrer: c.req.header("referer") ?? "",
          ipAddress:
            c.req.header("cf-connecting-ip") ||
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
            "unknown",
          userAgent: c.req.header("user-agent") ?? "unknown",
          source: "hosted_frontend",
          metadata: { host, deploymentId: deployment.id },
        })
        .catch((error) =>
          logger.warn("[Hosted Frontend] page-view record failed", {
            appId: appRow.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      try {
        c.executionCtx.waitUntil(record);
      } catch {
        // no Worker execution context (tests) — the record promise still runs.
      }
    }

    return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
  } catch (error) {
    logger.error("[Hosted Frontend] serve failed:", error);
    return c.text("Internal Server Error", 500);
  }
});

export default app;
