/**
 * GET /api/v1/billing/limits
 *
 * Read-only, organization-scoped snapshot of the account limits the backend
 * actually enforces (#19777). The organization comes exclusively from the
 * authenticated user / API-key membership — no client-supplied org id — and
 * viewers may read it (nothing here mutates or reveals secrets). Assembly and
 * failure semantics live in `account-limits-snapshot.ts`; this route only
 * wires the canonical enforcement sources.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import {
  DEFAULT_ORG_STORAGE_BYTES_LIMIT,
  orgStorageQuotaRepository,
} from "@/db/repositories/org-storage-quota";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { userCharacters } from "@/db/schemas/user-characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { getMaxCloudCharactersForOrg } from "@/lib/constants/cloud-character-quota";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { buildAccountLimitsSnapshot } from "@/lib/services/account-limits-snapshot";
import { appsService, getMaxAppsPerOrg } from "@/lib/services/apps";
import { containerQuotaService } from "@/lib/services/container-quota";
import { QUOTA_COUNTED_STATUSES } from "@/lib/services/eliza-sandbox";
import { getOrgTier } from "@/lib/services/org-rate-limits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const organizationId = user.organization_id;

    const snapshot = await buildAccountLimitsSnapshot({
      orgBilling: async () => {
        const org = await dbRead.query.organizations.findFirst({
          where: (table, { eq: whereEq }) => whereEq(table.id, organizationId),
          columns: { credit_balance: true, settings: true },
        });
        if (!org) throw new Error("Organization not found");
        return {
          creditBalance: Number(org.credit_balance),
          settings: org.settings as Record<string, unknown> | undefined,
        };
      },
      cloudCharacterCount: async () => {
        const [{ count } = { count: Number.NaN }] = await dbRead
          .select({ count: sql<number>`count(*)::int` })
          .from(userCharacters)
          .where(
            and(
              eq(userCharacters.organization_id, organizationId),
              eq(userCharacters.source, "cloud"),
            ),
          );
        return count;
      },
      sandboxQuotaCount: async () => {
        // Mirrors `assertOrgAgentQuota`'s counted set exactly: quota-holding
        // statuses (including stopped/sleeping), non-pool rows only.
        const [{ count } = { count: Number.NaN }] = await dbRead
          .select({ count: sql<number>`count(*)::int` })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.organization_id, organizationId),
              sql`${agentSandboxes.pool_status} IS NULL`,
              inArray(agentSandboxes.status, QUOTA_COUNTED_STATUSES),
            ),
          );
        return count;
      },
      containerQuota: async () => {
        const quota = await containerQuotaService.checkQuota(organizationId);
        return { current: quota.current, max: quota.max };
      },
      appCount: () => appsService.countByOrganization(organizationId),
      appLimit: async () => getMaxAppsPerOrg(),
      storageQuota: async () => {
        const row =
          await orgStorageQuotaRepository.findByOrganization(organizationId);
        if (!row) return null;
        return { bytesUsed: row.bytes_used, bytesLimit: row.bytes_limit };
      },
      inferenceRateTier: async () => {
        const tier = await getOrgTier(organizationId);
        return {
          completionsRpm: tier.completionsRpm,
          embeddingsRpm: tier.embeddingsRpm,
        };
      },
      maxCloudCharacters: getMaxCloudCharactersForOrg,
      maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg,
      defaultStorageBytesLimit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
    });

    return c.json({ success: true, data: snapshot });
  } catch (error) {
    logger.error("[Billing Limits API] Error building limits snapshot", error);
    return failureResponse(c, error);
  }
});

export default app;
