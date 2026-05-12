/**
 * POST /api/v1/apps/:id/domains/status
 *
 * Read current verification + SSL status of a domain attached to the app.
 * Live for cloudflare-registered; stored values for external.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { managedDomainsService } from "@/lib/services/managed-domains";
import type { AppEnv } from "@/types/cloud-worker-env";

const StatusSchema = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .transform((d) => d.toLowerCase().trim()),
});

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

    const parsed = StatusSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "invalid input" },
        400,
      );
    }

    const md = await managedDomainsService.getDomainByName(parsed.data.domain);
    if (!md || md.organizationId !== user.organization_id || md.appId !== appId) {
      return c.json({ success: false, error: "Domain not attached to this app" }, 404);
    }

    let live: {
      status: string;
      completedAt: string | null;
      failureReason: string | null;
    } | null = null;
    if (md.registrar === "cloudflare") {
      live = await cloudflareRegistrarService.getRegistrationStatus(md.domain);
    }

    return c.json({
      success: true,
      domain: md.domain,
      registrar: md.registrar,
      status: live?.status ?? md.status,
      verified: md.verified,
      sslStatus: md.sslStatus,
      expiresAt: md.expiresAt,
      live,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
