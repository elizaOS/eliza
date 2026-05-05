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
import { cloudflareDnsService } from "@/lib/services/cloudflare-dns";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { DNS_RECORD_TYPES, loadCloudflareManagedDomain } from "./context";

const CreateRecordSchema = z.object({
  type: z.enum(DNS_RECORD_TYPES),
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().min(0).max(65535).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const ctx = await loadCloudflareManagedDomain(c);
    if ("error" in ctx) return c.json({ success: false, error: ctx.error }, ctx.status);

    const records = await cloudflareDnsService.listRecords(ctx.zoneId);
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

    const created = await cloudflareDnsService.createRecord(ctx.zoneId, parsed.data);
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
