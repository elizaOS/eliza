/**
 * /api/v1/cron/shared-agent-keepwarm
 * Re-hydrates the cache-only shared first-turn gates for recently active
 * agents so an idle-expired cache never bills a human's next message with the
 * retryable 503 warming wall (measured 10-27s of first-message latency). Runs
 * the SAME best-effort prewarm legs agent-create uses — admission snapshot,
 * pricing, character projection — plus the isolate kernel prewarm; by the
 * prewarm contract this can only remove latency, never change an
 * authorization or billing outcome. Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { sharedRuntimeHistoryRepository } from "@/db/repositories/shared-runtime-history";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { isPersonalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";
import { prewarmSharedAgentTurnCaches } from "@/lib/services/shared-runtime/prewarm-shared-agent";
import { prewarmSharedElizaRuntime } from "@/lib/services/shared-runtime/shared-eliza-runtime";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/** Activity window: anyone who chatted within it stays warm. */
const KEEPWARM_WINDOW_MS = 24 * 60 * 60_000;
/** Per-invocation cap so a busy deployment cannot turn the sweep unbounded. */
const KEEPWARM_MAX_AGENTS = 50;

async function runKeepwarm(c: AppContext) {
  try {
    requireCronSecret(c);

    const since = new Date(Date.now() - KEEPWARM_WINDOW_MS);
    const agentIds =
      await sharedRuntimeHistoryRepository.listRecentlyActiveAgentIds(
        since,
        KEEPWARM_MAX_AGENTS,
      );

    let warmed = 0;
    let rowlessPersonal = 0;
    let missing = 0;
    for (const agentId of agentIds) {
      // Account-native Personal Shared identities have no agent_sandboxes row.
      // Their process-wide kernel is warmed below; sending the namespaced id to
      // the UUID repository aborts the whole sweep before that can happen.
      if (isPersonalSharedAgentId(agentId)) {
        rowlessPersonal++;
        continue;
      }
      const agent = await agentSandboxesRepository.findById(agentId);
      if (!agent) {
        missing++;
        continue;
      }
      // Sequential on purpose: the sweep is latency-insensitive background
      // work, and a serial walk keeps its DB/KV pressure flat regardless of
      // how many agents the window catches.
      await prewarmSharedAgentTurnCaches(agent, {
        namespace: c.env.SHARED_RUNTIME_CONVERSATIONS,
      });
      warmed++;
    }

    await prewarmSharedElizaRuntime();

    logger.info("[SharedKeepwarm Cron] swept recently active shared agents", {
      candidates: agentIds.length,
      warmed,
      rowlessPersonal,
      missing,
    });

    return c.json({
      success: true,
      data: { candidates: agentIds.length, warmed, rowlessPersonal, missing },
    });
  } catch (error) {
    logger.error("[SharedKeepwarm Cron] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

app.get("/", runKeepwarm);
app.post("/", runKeepwarm);

export default app;
