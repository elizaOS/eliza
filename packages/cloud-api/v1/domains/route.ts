/**
 * GET /api/v1/domains - list every managed domain in the user's organization
 *
 * Org-wide listing across all apps. Per-app listing lives at
 * /api/v1/apps/:id/domains.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { managedDomainsService } from "@/lib/services/managed-domains";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const domains = await managedDomainsService.listForOrganization(user.organization_id);
    return c.json({
      success: true,
      domains: domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        registrar: d.registrar,
        status: d.status,
        verified: d.verified,
        sslStatus: d.sslStatus,
        expiresAt: d.expiresAt,
        autoRenew: d.autoRenew,
        resourceType: d.resourceType,
        appId: d.appId,
        containerId: d.containerId,
        agentId: d.agentId,
        mcpId: d.mcpId,
        cloudflareZoneId: d.cloudflareZoneId,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
