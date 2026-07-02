/**
 * POST /api/cron/reclaim-stale-domains
 *
 * Daily cron that releases external managed-domain rows still unverified after
 * the reclaim TTL, so an unproven attach can't squat a domain forever (#11058;
 * reclaim primitive from #11051). TTL defaults to 48h and can be overridden
 * with MANAGED_DOMAIN_UNVERIFIED_TTL_MS. Protected by CRON_SECRET. See
 * managed-domains service (`releaseStaleUnverifiedExternals`).
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const DEFAULT_STALE_UNVERIFIED_TTL_MS = 48 * 60 * 60 * 1000;

/** Positive finite MANAGED_DOMAIN_UNVERIFIED_TTL_MS wins; anything else -> 48h default. */
export function resolveStaleUnverifiedTtlMs(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STALE_UNVERIFIED_TTL_MS;
}

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const ttlMs = resolveStaleUnverifiedTtlMs(
      c.env.MANAGED_DOMAIN_UNVERIFIED_TTL_MS,
    );
    const released =
      await managedDomainsService.releaseStaleUnverifiedExternals(ttlMs);
    logger.info(
      `[ManagedDomains] reclaimed ${released} stale unverified external rows (ttlMs=${ttlMs})`,
      {
        durationMs: Date.now() - startedAt,
        released,
        ttlMs,
      },
    );
    return c.json({ success: true, released, ttlMs });
  } catch (error) {
    logger.error("[ManagedDomains] reclaim-stale-domains cron failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
