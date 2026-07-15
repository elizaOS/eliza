/**
 * POST /api/cron/gc-stranded-sandbox-keys
 *
 * Periodic sweep that revokes STRANDED `agent-sandbox:<uuid>` API keys (#16071):
 * active keys whose bound sandbox id has no `agent_sandboxes` row and that are
 * older than the grace window. These are minted by the tier-upgrade
 * single-flight boundary (#15943, #16042) BEFORE the locked commit of the
 * target sandbox row; a process crash in that window strands an active key for
 * a sandbox that never existed. Every ordinary failure path already revokes the
 * candidate key, so only the crash-in-the-window leaves this orphan and nothing
 * else GCs it.
 *
 * The grace window (default 6h, overridable with STRANDED_SANDBOX_KEY_GRACE_MS)
 * must comfortably exceed any real mint-to-commit latency so a key minted for
 * an in-flight single-flight mint still holding the tier-upgrade lock is never
 * touched. Protected by CRON_SECRET.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { strandedAgentKeySweeper } from "@/lib/services/stranded-agent-key-sweeper";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const DEFAULT_STRANDED_SANDBOX_KEY_GRACE_MS = 6 * 60 * 60 * 1000;

/** Positive finite STRANDED_SANDBOX_KEY_GRACE_MS wins; anything else -> 6h default. */
export function resolveStrandedSandboxKeyGraceMs(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STRANDED_SANDBOX_KEY_GRACE_MS;
}

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const graceMs = resolveStrandedSandboxKeyGraceMs(
      c.env.STRANDED_SANDBOX_KEY_GRACE_MS,
    );
    const olderThan = new Date(startedAt - graceMs);
    const revoked = await strandedAgentKeySweeper.sweep(olderThan);
    logger.info(
      `[ApiKeys] gc-stranded-sandbox-keys revoked ${revoked} stranded keys (graceMs=${graceMs})`,
      {
        durationMs: Date.now() - startedAt,
        revoked,
        graceMs,
      },
    );
    return c.json({ success: true, revoked, graceMs });
  } catch (error) {
    // error-policy:J1 The cron route is the transport boundary for sweep failures.
    logger.error("[ApiKeys] gc-stranded-sandbox-keys cron failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
