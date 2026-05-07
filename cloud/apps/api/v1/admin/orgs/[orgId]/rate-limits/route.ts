import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin endpoint for per-organization rate limit overrides.
 *
 * GET    — read current override (if any) + computed tier
 * PATCH  — upsert override fields
 * DELETE — remove all overrides (revert to automatic tier)
 *
 * Auth: requireAdminWithResponse — superadmin only. All admins can modify any org.
 * There are no tenant-scoped admin roles in the current system.
 */

import { z } from "zod";
import { orgRateLimitOverridesRepository } from "@/db/repositories/org-rate-limit-overrides";
import { organizationsRepository } from "@/db/repositories/organizations";
import { requireAdminWithResponse } from "@/lib/auth/admin";
import { getOrgTier, invalidateOrgTierCache } from "@/lib/services/org-rate-limits";
import { logger } from "@/lib/utils/logger";

type RouteContext = { params: Promise<{ orgId: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOrgId(orgId: string): Response | null {
  if (!UUID_RE.test(orgId)) {
    return Response.json({ error: "Invalid org ID" }, { status: 400 });
  }
  return null;
}

async function __hono_GET(request: Request, context: RouteContext) {
  const authResult = await requireAdminWithResponse(request, "[Admin] Org rate limits auth error");
  if (authResult instanceof Response) return authResult;

  const { orgId } = await context.params;
  const invalid = validateOrgId(orgId);
  if (invalid) return invalid;

  try {
    const [override, tier] = await Promise.all([
      orgRateLimitOverridesRepository.findByOrganizationId(orgId),
      getOrgTier(orgId),
    ]);

    return Response.json({
      organization_id: orgId,
      computed_tier: tier,
      override: override ?? null,
    });
  } catch (error) {
    logger.error("[Admin] Org rate limits GET error", { error, orgId });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH semantics: null = clear override (revert to tier default), omit = keep current value.
const PatchSchema = z.object({
  completions_rpm: z.number().int().min(1).max(10_000).nullable().optional(),
  embeddings_rpm: z.number().int().min(1).max(10_000).nullable().optional(),
  standard_rpm: z.number().int().min(1).max(10_000).nullable().optional(),
  strict_rpm: z.number().int().min(1).max(10_000).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

async function __hono_PATCH(request: Request, context: RouteContext) {
  const authResult = await requireAdminWithResponse(request, "[Admin] Org rate limits auth error");
  if (authResult instanceof Response) return authResult;

  const { orgId } = await context.params;
  const invalid = validateOrgId(orgId);
  if (invalid) return invalid;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Reject empty PATCH — at least one RPM or note field must be provided
  const hasFields = [
    "completions_rpm",
    "embeddings_rpm",
    "standard_rpm",
    "strict_rpm",
    "note",
  ].some((k) => k in parsed.data);
  if (!hasFields) {
    return Response.json(
      { error: "At least one override field must be provided" },
      { status: 400 },
    );
  }

  try {
    const org = await organizationsRepository.findById(orgId);
    if (!org) {
      return Response.json({ error: "Organization not found" }, { status: 404 });
    }
    // Pass values as-is: null clears a field, undefined = not provided (no change)
    const result = await orgRateLimitOverridesRepository.upsert({
      organization_id: orgId,
      ...("completions_rpm" in parsed.data && {
        completions_rpm: parsed.data.completions_rpm,
      }),
      ...("embeddings_rpm" in parsed.data && {
        embeddings_rpm: parsed.data.embeddings_rpm,
      }),
      ...("standard_rpm" in parsed.data && {
        standard_rpm: parsed.data.standard_rpm,
      }),
      ...("strict_rpm" in parsed.data && {
        strict_rpm: parsed.data.strict_rpm,
      }),
      ...("note" in parsed.data && { note: parsed.data.note }),
    });

    await invalidateOrgTierCache(orgId);

    logger.info("[Admin] Org rate limit override updated", {
      orgId,
      override: result,
      updatedBy: authResult.user?.id,
    });

    return Response.json(result);
  } catch (error) {
    logger.error("[Admin] Org rate limits PATCH error", { error, orgId });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function __hono_DELETE(request: Request, context: RouteContext) {
  const authResult = await requireAdminWithResponse(request, "[Admin] Org rate limits auth error");
  if (authResult instanceof Response) return authResult;

  const { orgId } = await context.params;
  const invalid = validateOrgId(orgId);
  if (invalid) return invalid;

  try {
    await orgRateLimitOverridesRepository.deleteByOrganizationId(orgId);
    await invalidateOrgTierCache(orgId);

    logger.info("[Admin] Org rate limit override deleted", {
      orgId,
      deletedBy: authResult.user?.id,
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    logger.error("[Admin] Org rate limits DELETE error", { error, orgId });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ orgId: c.req.param("orgId")! }) }),
);
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, { params: Promise.resolve({ orgId: c.req.param("orgId")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ orgId: c.req.param("orgId")! }) }),
);
export default __hono_app;
