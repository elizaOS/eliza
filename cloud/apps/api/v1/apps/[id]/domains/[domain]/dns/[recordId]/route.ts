/**
 * GET    /api/v1/apps/:id/domains/:domain/dns/:recordId - read one record
 * PATCH  /api/v1/apps/:id/domains/:domain/dns/:recordId - edit one record
 * DELETE /api/v1/apps/:id/domains/:domain/dns/:recordId - remove one record
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { cloudflareDnsService } from "@/lib/services/cloudflare-dns";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const RecordTypes = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"] as const;

const PatchRecordSchema = z
  .object({
    type: z.enum(RecordTypes).optional(),
    name: z.string().min(1).max(255).optional(),
    content: z.string().min(1).max(2048).optional(),
    ttl: z.number().int().min(1).max(86400).optional(),
    proxied: z.boolean().optional(),
    priority: z.number().int().min(0).max(65535).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "patch must include at least one field");

const app = new Hono<AppEnv>();

async function loadCloudflareManagedDomain(c: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const appId = c.req.param("id");
  const domainParam = c.req.param("domain");
  const recordId = c.req.param("recordId");
  if (!appId || !domainParam || !recordId) {
    return { error: "missing path params", status: 400 as const };
  }

  const appRow = await appsService.getById(appId);
  if (!appRow || appRow.organization_id !== user.organization_id) {
    return { error: "App not found", status: 404 as const };
  }

  const md = await managedDomainsService.getDomainByName(decodeURIComponent(domainParam));
  if (!md || md.organizationId !== user.organization_id || md.appId !== appId) {
    return { error: "Domain not attached to this app", status: 404 as const };
  }
  if (md.registrar !== "cloudflare" || !md.cloudflareZoneId) {
    return {
      error: "DNS records on external domains must be edited at your existing DNS provider",
      status: 409 as const,
    };
  }
  return { user, appId, domain: md, recordId };
}

app.get("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    const rec = await cloudflareDnsService.getRecord(
      ctx.domain.cloudflareZoneId as string,
      ctx.recordId,
    );
    return c.json({ success: true, record: rec });
  } catch (error) {
    logger.error("[Domains DNS GET one] failed", { error: extractErrorMessage(error) });
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    const parsed = PatchRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "invalid input" },
        400,
      );
    }

    const updated = await cloudflareDnsService.updateRecord(
      ctx.domain.cloudflareZoneId as string,
      ctx.recordId,
      parsed.data,
    );
    logger.info("[Domains DNS PATCH] updated", {
      appId: ctx.appId,
      domain: ctx.domain.domain,
      recordId: ctx.recordId,
    });
    return c.json({ success: true, record: updated });
  } catch (error) {
    logger.error("[Domains DNS PATCH] failed", { error: extractErrorMessage(error) });
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    await cloudflareDnsService.deleteRecord(ctx.domain.cloudflareZoneId as string, ctx.recordId);
    logger.info("[Domains DNS DELETE] removed", {
      appId: ctx.appId,
      domain: ctx.domain.domain,
      recordId: ctx.recordId,
    });
    return c.json({ success: true, recordId: ctx.recordId });
  } catch (error) {
    logger.error("[Domains DNS DELETE] failed", { error: extractErrorMessage(error) });
    return failureResponse(c, error);
  }
});

export default app;
