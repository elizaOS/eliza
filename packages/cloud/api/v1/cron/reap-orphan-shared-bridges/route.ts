// Handles v1 cloud API v1 cron reap orphan shared bridges route traffic with route-local auth expectations.

import { parseCanonicalInteger } from "@elizaos/shared";
import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reapOrphanedSharedBridges } from "@/lib/services/orphan-shared-bridge-reaper";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Orphan-shared bridge reaper cron (#9939).
 *
 * Deletes shared-tier `agent_sandboxes` rows (and, via the same cascade,
 * `shared_runtime_history`) left behind when a seamless shared→dedicated
 * handoff times out / fails and never reached the success-path bridge delete.
 * A cheap, capped DB sweep (no container control-plane hop), so it piggybacks
 * the low-frequency 6-hourly tick alongside `agent-backups` rather than
 * carrying its own schedule. Conservative by construction: only reaps a shared
 * bridge well past the handoff window that a live dedicated twin has clearly
 * superseded (see `orphan-shared-bridge-reaper.ts`).
 *
 * Tunables via query string: `?minAgeMs=<n>&max=<n>`.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(
    c.req.raw,
    "[Reap Orphan Shared Bridges]",
    env,
  );
  if (authError) return authError;

  const url = new URL(c.req.url);
  const minAgeMs = parseCanonicalInteger(url.searchParams.get("minAgeMs"), {
    min: 1,
  });
  const max = parseCanonicalInteger(url.searchParams.get("max"), { min: 1 });
  if (minAgeMs === "invalid" || max === "invalid") {
    return c.json(
      {
        success: false,
        error: "minAgeMs and max must be canonical positive integers",
      },
      400,
    );
  }

  const result = await reapOrphanedSharedBridges({
    minAgeMs,
    max,
  });

  logger.info("[Reap Orphan Shared Bridges] sweep complete", { ...result });
  return c.json({ success: true, ...result });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;
