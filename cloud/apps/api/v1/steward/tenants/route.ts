/**
 * POST /api/v1/steward/tenants
 *
 * Provisions a new Steward tenant for the authenticated user's organization.
 * Idempotent: if the org already has a Steward tenant, returns the existing ID.
 *
 * This endpoint is called automatically during organization setup when
 * Steward-backed auth is enabled for the organization.
 *
 * Body: { organizationId: string; tenantName?: string }
 * Returns: { tenantId: string; isNew: boolean }
 */

import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";
import { logger } from "@/lib/utils/logger";
import { dbWrite } from "@/packages/db/helpers";
import { organizations } from "@/packages/db/schemas/organizations";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

function getStewardApiUrl(c: Context<AppEnv>): string {
  return resolveServerStewardApiUrlFromEnv(c.env, new URL(c.req.url).origin);
}

function getPlatformKey(env: Bindings): string {
  const key = (env.STEWARD_PLATFORM_KEYS ?? "").split(",")[0]?.trim();
  if (!key) throw new Error("STEWARD_PLATFORM_KEYS is not configured");
  return key;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = (await c.req.json()) as {
      organizationId?: string;
      tenantName?: string;
    };
    if (!body.organizationId) {
      return c.json({ error: "organizationId is required" }, 400);
    }
    if (body.organizationId !== user.organization_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const [org] = await dbWrite
      .select({
        id: organizations.id,
        slug: organizations.slug,
        stewardTenantId: organizations.steward_tenant_id,
      })
      .from(organizations)
      .where(eq(organizations.id, body.organizationId))
      .limit(1);

    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Idempotent — already provisioned
    if (org.stewardTenantId) {
      return c.json({ tenantId: org.stewardTenantId, isNew: false });
    }

    const tenantId = `elizacloud-${org.slug}`;
    const tenantName = body.tenantName ?? `ElizaCloud — ${org.slug}`;

    let platformKey: string;
    try {
      platformKey = getPlatformKey(c.env);
    } catch {
      logger.error("[steward-tenants] STEWARD_PLATFORM_KEYS not configured");
      return c.json({ error: "Steward not configured" }, 503);
    }

    const stewardRes = await fetch(`${getStewardApiUrl(c)}/platform/tenants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": platformKey,
      },
      body: JSON.stringify({ id: tenantId, name: tenantName }),
    });

    const stewardData = (await stewardRes.json()) as {
      ok: boolean;
      apiKey?: string;
      data?: { apiKey?: string };
      error?: string;
    };

    if (stewardRes.status === 409) {
      // Tenant already exists in Steward but not linked in our DB — re-link without API key
      logger.warn(`[steward-tenants] Tenant ${tenantId} already exists in Steward, linking org`);
      await dbWrite
        .update(organizations)
        .set({ steward_tenant_id: tenantId })
        .where(eq(organizations.id, org.id));
      return c.json({ tenantId, isNew: false });
    }

    if (!stewardRes.ok || !stewardData.ok) {
      logger.error("[steward-tenants] Failed to create Steward tenant", {
        error: stewardData.error,
      });
      return c.json({ error: "Failed to provision Steward tenant" }, 502);
    }

    const apiKey = stewardData.apiKey ?? stewardData.data?.apiKey ?? "";

    await dbWrite
      .update(organizations)
      .set({ steward_tenant_id: tenantId, steward_tenant_api_key: apiKey })
      .where(eq(organizations.id, org.id));

    logger.info(`[steward-tenants] Provisioned tenant ${tenantId} for org ${org.id}`);
    return c.json({ tenantId, isNew: true }, 201);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
