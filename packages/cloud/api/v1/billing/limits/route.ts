/**
 * Serves the read-only, organization-scoped billing snapshot (#22954), with
 * its additive v2 observations and exact temporary v1 limits projection. The
 * organization comes exclusively from authenticated user/API-key membership;
 * no client-supplied id is a tenant-selection seam. Assembly and failure
 * semantics live in `account-limits-snapshot.ts`; this route only wires the
 * canonical enforcement sources.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { readPrimaryAccountBillingSnapshot } from "@elizaos/cloud-shared/db/repositories/account-billing-snapshot";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { buildAccountBillingSnapshot } from "@elizaos/cloud-shared/lib/services/account-limits-snapshot";
import { getOrgTierCacheOnly } from "@elizaos/cloud-shared/lib/services/org-rate-limits";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const organizationId = user.organization_id;

    const snapshot = await buildAccountBillingSnapshot({
      primary: () => readPrimaryAccountBillingSnapshot(organizationId),
      runtimeTierCache: () => getOrgTierCacheOnly(organizationId),
      autoTopUpRuntimeEnabled: () =>
        c.env?.AUTO_TOP_UP_DURABLE_ENABLED === "true",
      cancellationAuthority: {
        authMethod: c.get("authMethod") ?? null,
        role: user.role ?? null,
        // Match the fresh account predicate enforced again by the mutation
        // boundary. Optional auth-shim fields fail closed when absent.
        userActive: user.is_active === true,
        userAnonymous: user.is_anonymous !== false,
        organizationActive: user.organization.is_active === true,
      },
      now: () => new Date(),
    });

    return c.json({ success: true, data: snapshot });
  } catch (error) {
    // error-policy:J1 — the HTTP boundary records the internal failure and
    // delegates its client-safe status/envelope translation.
    logger.error("[Billing Limits API] Error building limits snapshot", error);
    return failureResponse(c, error);
  }
});

export default app;
