/**
 * POST /api/v1/apps/:id/domains/sync
 *
 * For each cloudflare-registered domain attached to the app, fetch the
 * latest status from cloudflare and persist it back to managed_domains.
 * Also bumps lastHealthCheck on every row touched.
 */

import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cloudflareRegistrarService } from "@elizaos/cloud-shared/lib/services/cloudflare-registrar";
import { managedDomainsService } from "@elizaos/cloud-shared/lib/services/managed-domains";
import { extractErrorMessage } from "@elizaos/cloud-shared/lib/utils/error-handling";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { loadOwnedApp } from "../guards";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);
    const { user, appId } = ctx;

    const domains = await managedDomainsService.listForApp(
      user.organization_id,
      appId,
    );

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
          const live = await cloudflareRegistrarService.getRegistrationStatus(
            md.domain,
          );
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

    return c.json({
      success: true,
      domains: results,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
