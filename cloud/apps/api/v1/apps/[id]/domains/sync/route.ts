/**
 * POST /api/v1/apps/:id/domains/sync
 *
 * For each cloudflare-registered domain attached to the app, fetch the
 * latest status from cloudflare and persist it back to managed_domains.
 * Also bumps lastHealthCheck on every row touched.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const appRow = await appsService.getById(appId);
    if (!appRow || appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    const domains = await managedDomainsService.listForApp(user.organization_id, appId);

    const results = await Promise.all(
      domains.map(async (md) => {
        if (md.registrar !== "cloudflare") {
          return {
            domain: md.domain,
            registrar: md.registrar,
            synced: false,
            status: md.status,
          };
        }
        try {
          const live = await cloudflareRegistrarService.getRegistrationStatus(md.domain);
          const persisted = await managedDomainsService.syncStatus({
            domainId: md.id,
            status: live.status === "active" ? "active" : md.status,
            isLive: live.status === "active",
            healthCheckError: null,
          });
          return {
            domain: md.domain,
            registrar: md.registrar,
            synced: true,
            status: persisted.status,
            completedAt: live.completedAt,
          };
        } catch (err) {
          const message = extractErrorMessage(err);
          logger.warn("[Domains Sync] cloudflare status fetch failed", {
            appId,
            domain: md.domain,
            error: message,
          });
          await managedDomainsService.syncStatus({
            domainId: md.id,
            healthCheckError: message,
          });
          return {
            domain: md.domain,
            registrar: md.registrar,
            synced: false,
            status: md.status,
            error: message,
          };
        }
      }),
    );

    return c.json({ success: true, domains: results, syncedAt: new Date().toISOString() });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
