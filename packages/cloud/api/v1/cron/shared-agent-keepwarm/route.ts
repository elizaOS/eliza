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

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { sharedRuntimeHistoryRepository } from "@elizaos/cloud-shared/db/repositories/shared-runtime-history";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isPersonalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
import {
  prewarmPersonalSharedRoom,
  prewarmSharedAgentTurnCaches,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/prewarm-shared-agent";
import { prewarmSharedElizaRuntime } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-eliza-runtime";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

/** Activity window: anyone who chatted within it stays warm. */
const KEEPWARM_WINDOW_MS = 24 * 60 * 60_000;
/** Per-invocation cap so a busy deployment cannot turn the sweep unbounded. */
const KEEPWARM_MAX_AGENTS = 50;
/** Per-invocation cap on Personal Shared rooms, bounded like the agent sweep. */
const KEEPWARM_MAX_PERSONAL_ROOMS = 50;

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
      // Account-native Personal Shared identities have no agent_sandboxes row;
      // sending the namespaced id to the UUID repository would abort the
      // sweep. Their rooms are warmed per room below.
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

    // Personal Shared identities are the ones whose first turn hit the warming
    // 503 (#22552): warm each recently active room's conversation object and
    // turn-ingress modules. Sequential for the same flat-pressure reason.
    let personalRoomsWarmed = 0;
    let personalOrganizationsWarmed = 0;
    // Select eligible personal rooms independently: the global agent hot set
    // can be filled entirely by newer sandbox agents.
    const rooms =
      await sharedRuntimeHistoryRepository.listRecentlyActivePersonalRooms(
        since,
        KEEPWARM_MAX_PERSONAL_ROOMS,
      );
    if (rooms.length > 0) {
      const namespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
      if (!namespace) {
        throw new Error(
          "SHARED_RUNTIME_CONVERSATIONS binding is required to warm Personal Shared rooms",
        );
      }
      // Each room reports its verified owner; the owning organization's
      // rate-limit gate is warmed once per sweep.
      const warmedOrganizations = new Set<string>();
      for (const room of rooms) {
        if (!isPersonalSharedAgentId(room.agentId)) continue;
        await prewarmPersonalSharedRoom(
          room.agentId,
          room.channelId,
          namespace,
          warmedOrganizations,
        );
        personalRoomsWarmed++;
      }
      personalOrganizationsWarmed = warmedOrganizations.size;
    }

    await prewarmSharedElizaRuntime();

    logger.info("[SharedKeepwarm Cron] swept recently active shared agents", {
      candidates: agentIds.length,
      warmed,
      rowlessPersonal,
      personalRoomsWarmed,
      personalOrganizationsWarmed,
      missing,
    });

    return c.json({
      success: true,
      data: {
        candidates: agentIds.length,
        warmed,
        rowlessPersonal,
        personalRoomsWarmed,
        personalOrganizationsWarmed,
        missing,
      },
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
