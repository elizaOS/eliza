/**
 * Webhook configuration and delivery tracking routes.
 *
 * Mount: app.route("/webhooks", webhookRoutes)
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  db,
  isNonEmptyString,
  requireTenantLevel,
  safeJsonParse,
  webhookConfigs,
  webhookDeliveries,
} from "../services/context";

export const webhookRoutes = new Hono<{ Variables: AppVariables }>();

// Valid webhook event types
const VALID_EVENTS = [
  "tx.pending",
  "tx.approved",
  "tx.denied",
  "tx.signed",
  "spend.threshold",
  "policy.violation",
] as const;

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

// ─── Register webhook ─────────────────────────────────────────────────────────

webhookRoutes.post("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{
    url: string;
    events?: string[];
    description?: string;
    maxRetries?: number;
    retryBackoffMs?: number;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.url) || !isValidUrl(body.url)) {
    return c.json<ApiResponse>({ ok: false, error: "url must be a valid HTTP(S) URL" }, 400);
  }

  // Validate events if provided
  if (body.events) {
    if (!Array.isArray(body.events)) {
      return c.json<ApiResponse>({ ok: false, error: "events must be an array" }, 400);
    }
    const invalidEvents = body.events.filter(
      (e) => !(VALID_EVENTS as readonly string[]).includes(e),
    );
    if (invalidEvents.length > 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Invalid events: ${invalidEvents.join(", ")}. Valid: ${VALID_EVENTS.join(", ")}`,
        },
        400,
      );
    }
  }

  if (
    body.maxRetries !== undefined &&
    (typeof body.maxRetries !== "number" || body.maxRetries < 0 || body.maxRetries > 10)
  ) {
    return c.json<ApiResponse>({ ok: false, error: "maxRetries must be 0-10" }, 400);
  }

  if (
    body.retryBackoffMs !== undefined &&
    (typeof body.retryBackoffMs !== "number" || body.retryBackoffMs < 1000)
  ) {
    return c.json<ApiResponse>({ ok: false, error: "retryBackoffMs must be >= 1000" }, 400);
  }

  const secret = generateSecret();

  const [webhook] = await db
    .insert(webhookConfigs)
    .values({
      tenantId,
      url: body.url,
      secret,
      events: body.events || [...VALID_EVENTS],
      description: body.description,
      maxRetries: body.maxRetries ?? 5,
      retryBackoffMs: body.retryBackoffMs ?? 60000,
    })
    .returning();

  return c.json<ApiResponse>(
    {
      ok: true,
      data: webhook,
    },
    201,
  );
});

// ─── List webhooks ────────────────────────────────────────────────────────────

webhookRoutes.get("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");

  const webhooks = await db
    .select({
      id: webhookConfigs.id,
      tenantId: webhookConfigs.tenantId,
      url: webhookConfigs.url,
      events: webhookConfigs.events,
      enabled: webhookConfigs.enabled,
      maxRetries: webhookConfigs.maxRetries,
      retryBackoffMs: webhookConfigs.retryBackoffMs,
      description: webhookConfigs.description,
      createdAt: webhookConfigs.createdAt,
      updatedAt: webhookConfigs.updatedAt,
      // Omit secret from list view
    })
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, tenantId))
    .orderBy(desc(webhookConfigs.createdAt));

  return c.json<ApiResponse>({ ok: true, data: webhooks });
});

// ─── Update webhook ───────────────────────────────────────────────────────────

webhookRoutes.put("/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const webhookId = c.req.param("id");

  const body = await safeJsonParse<{
    url?: string;
    events?: string[];
    enabled?: boolean;
    description?: string;
    maxRetries?: number;
    retryBackoffMs?: number;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  // Check webhook exists and belongs to tenant
  const [existing] = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)));

  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Webhook not found" }, 404);
  }

  if (body.url !== undefined && (!isNonEmptyString(body.url) || !isValidUrl(body.url))) {
    return c.json<ApiResponse>({ ok: false, error: "url must be a valid HTTP(S) URL" }, 400);
  }

  if (body.events) {
    const invalidEvents = body.events.filter(
      (e) => !(VALID_EVENTS as readonly string[]).includes(e),
    );
    if (invalidEvents.length > 0) {
      return c.json<ApiResponse>(
        { ok: false, error: `Invalid events: ${invalidEvents.join(", ")}` },
        400,
      );
    }
  }

  const updates: Record<string, unknown> = {};
  if (body.url !== undefined) updates.url = body.url;
  if (body.events !== undefined) updates.events = body.events;
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (body.description !== undefined) updates.description = body.description;
  if (body.maxRetries !== undefined) updates.maxRetries = body.maxRetries;
  if (body.retryBackoffMs !== undefined) updates.retryBackoffMs = body.retryBackoffMs;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(webhookConfigs)
    .set(updates)
    .where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)))
    .returning();

  return c.json<ApiResponse>({ ok: true, data: updated });
});

// ─── Delete webhook ───────────────────────────────────────────────────────────

webhookRoutes.delete("/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const webhookId = c.req.param("id");

  const [deleted] = await db
    .delete(webhookConfigs)
    .where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Webhook not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: { deleted: true } });
});

// ─── Delivery history ─────────────────────────────────────────────────────────

webhookRoutes.get("/:id/deliveries", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const webhookId = c.req.param("id");

  // Verify webhook belongs to tenant
  const [webhook] = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)));

  if (!webhook) {
    return c.json<ApiResponse>({ ok: false, error: "Webhook not found" }, 404);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  // Filter deliveries by tenant and webhook URL
  const deliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.url, webhook.url)))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({ ok: true, data: deliveries });
});

// ─── Retry delivery ───────────────────────────────────────────────────────────

webhookRoutes.post("/deliveries/:id/retry", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const deliveryId = c.req.param("id");

  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.tenantId, tenantId)));

  if (!delivery) {
    return c.json<ApiResponse>({ ok: false, error: "Delivery not found" }, 404);
  }

  if (delivery.status === "delivered") {
    return c.json<ApiResponse>({ ok: false, error: "Delivery already succeeded" }, 400);
  }

  // Reset for retry
  const [updated] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      nextRetryAt: new Date(),
      lastError: null,
    })
    .where(eq(webhookDeliveries.id, deliveryId))
    .returning();

  return c.json<ApiResponse>({ ok: true, data: updated });
});
