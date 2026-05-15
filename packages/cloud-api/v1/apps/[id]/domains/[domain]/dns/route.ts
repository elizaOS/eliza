/**
 * GET  /api/v1/apps/:id/domains/:domain/dns - list dns records on a managed domain
 * POST /api/v1/apps/:id/domains/:domain/dns - add a dns record
 *
 * Only domains we registered through cloudflare are editable here. External
 * (user-owned-elsewhere) domains return 409 — the user must edit those at
 * their existing dns provider.
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

const CreateRecordSchema = z.object({
  type: z.enum(RecordTypes),
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().min(0).max(65535).optional(),
});

const app = new Hono<AppEnv>();

async function loadCloudflareManagedDomain(c: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const appId = c.req.param("id");
  const domainParam = c.req.param("domain");
  if (!appId || !domainParam) return { error: "missing path params", status: 400 as const };

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
  return { user, app: appRow, appId, domain: md };
}

app.get("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    const records = await cloudflareDnsService.listRecords(ctx.domain.cloudflareZoneId as string);
    return c.json({ success: true, domain: ctx.domain.domain, records });
  } catch (error) {
    logger.error("[Domains DNS GET] list failed", { error: extractErrorMessage(error) });
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    const parsed = CreateRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "invalid input" },
        400,
      );
    }

    const created = await cloudflareDnsService.createRecord(
      ctx.domain.cloudflareZoneId as string,
      parsed.data,
    );
    logger.info("[Domains DNS POST] record added", {
      appId: ctx.appId,
      domain: ctx.domain.domain,
      recordId: created.id,
      type: created.type,
    });
    return c.json({ success: true, record: created }, 201);
  } catch (error) {
    logger.error("[Domains DNS POST] add failed", { error: extractErrorMessage(error) });
    return failureResponse(c, error);
  }
});

export default app;
