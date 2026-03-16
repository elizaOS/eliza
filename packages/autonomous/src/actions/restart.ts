/**
 * RESTART_AGENT action — gracefully restarts the agent.
 *
 * When triggered the action:
 *   1. Persists a "Restarting…" memory so the event is visible in logs
 *   2. Returns a brief restart notice to the caller
 *   3. After a short delay (so the response can flush), invokes
 *      {@link requestRestart} which delegates to the registered
 *      {@link RestartHandler}.
 *
 * In CLI mode the default handler exits with code 75 so the runner script
 * rebuilds and relaunches. In headless / Electron mode a custom handler
 * performs an in-process restart (stop → re-init → hot-swap references).
 *
 * @module actions/restart
 */

import crypto from "node:crypto";
import type { Action, HandlerOptions, Memory, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { requestRestart } from "../runtime/restart";

/** Small delay (ms) before restarting so the response has time to flush. */
const SHUTDOWN_DELAY_MS = 1_500;

export const restartAction: Action = {
  name: "RESTART_AGENT",

  similes: [
    "RESTART",
    "REBOOT",
    "RELOAD",
    "REFRESH",
    "RESPAWN",
    "RESTART_SELF",
    "REBOOT_AGENT",
    "RELOAD_AGENT",
  ],

  description:
    "Restart the agent process. This stops the runtime, rebuilds if source " +
    "files changed, and relaunches — picking up new code, config, or plugins.",

  validate: async (_runtime, _message, _state) => {
    // Always valid — the registered handler decides how (or whether) to restart.
    return true;
  },

  handler: async (runtime, message, _state, options) => {
    // This action declares parameters, so the runtime provides HandlerOptions.
    const params = (options as HandlerOptions | undefined)?.parameters;
    const reason =
      typeof params?.reason === "string" ? params.reason : undefined;

    const restartText = reason ? `Restarting… (${reason})` : "Restarting…";

    logger.info(`[milady] ${restartText}`);

    // Persist a "Restarting…" memory so it shows up in the message log.
    try {
      const restartMemory: Memory = {
        id: crypto.randomUUID() as UUID,
        entityId: runtime.agentId,
        roomId: message.roomId,
        worldId: message.worldId,
        content: {
          text: restartText,
          source: "milady",
          type: "system",
        },
      };
      await runtime.createMemory(restartMemory, "messages");
    } catch (err) {
      // Non-fatal — the restart still proceeds even if the memory write fails.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[milady] Could not persist restart memory: ${msg}`);
    }

    // Schedule the restart slightly after returning so the response can be
    // delivered to the user / channel before the process bounces.
    setTimeout(() => {
      requestRestart(reason);
    }, SHUTDOWN_DELAY_MS);

    return {
      text: restartText,
      success: true,
      values: { restarting: true },
      data: { reason },
    };
  },

  parameters: [
    {
      name: "reason",
      description: "Optional reason for the restart (logged for diagnostics).",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
