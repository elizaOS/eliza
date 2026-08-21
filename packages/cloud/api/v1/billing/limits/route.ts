/**
 * Serves the read-only, organization-scoped billing snapshot (#22954), with
 * its additive v2 observations and exact temporary v1 limits projection. The
 * organization comes exclusively from authenticated user/API-key membership;
 * no client-supplied id is a tenant-selection seam. Assembly and failure
 * semantics live in `account-limits-snapshot.ts`; this route only wires the
 * canonical enforcement sources.
 */

import { Hono } from "hono";
import { readPrimaryAccountBillingSnapshot } from "@/db/repositories/account-billing-snapshot";
import { DEFAULT_ORG_STORAGE_BYTES_LIMIT } from "@/db/repositories/org-storage-quota";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { getMaxCloudCharactersForOrg } from "@/lib/constants/cloud-character-quota";
import { getMaxContainersForOrg } from "@/lib/constants/pricing";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { buildAccountBillingSnapshot } from "@/lib/services/account-limits-snapshot";
import { getMaxAppsPerOrg } from "@/lib/services/apps";
import { getOrgTierCacheOnly } from "@/lib/services/org-rate-limits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const organizationId = user.organization_id;

    const snapshot = await buildAccountBillingSnapshot({
      primary: () => readPrimaryAccountBillingSnapshot(organizationId),
      appLimit: getMaxAppsPerOrg,
      maxCloudCharacters: getMaxCloudCharactersForOrg,
      maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg,
      maxContainers: getMaxContainersForOrg,
      runtimeTierCache: () => getOrgTierCacheOnly(organizationId),
      autoTopUpRuntimeEnabled: () =>
        c.env?.AUTO_TOP_UP_DURABLE_ENABLED === "true",
      defaultStorageBytesLimit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
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
