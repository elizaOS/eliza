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
 * rebuilds and relaunches. In headless / desktop mode a custom handler
 * performs an in-process restart (stop → re-init → hot-swap references).
 *
 * @module actions/restart
 */

import crypto from "node:crypto";
import type {
  Action,
  ActionExample,
  HandlerOptions,
  Memory,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { requestRestart } from "../runtime/restart.js";
import { hasOwnerAccess } from "../security/access.js";

/** Small delay (ms) before restarting so the response has time to flush. */
const SHUTDOWN_DELAY_MS = 1_500;
const RESTART_REQUEST_TERMS = getValidationKeywordTerms(
  "action.restart.request",
  {
    includeAllLocales: true,
  },
);

function isExplicitRestartRequest(message: Memory | undefined): boolean {
  const userText = (message?.content?.text ?? "").trim();
  if (!userText) {
    return false;
  }

  if (userText.toLowerCase().startsWith("/restart")) {
    return true;
  }

  return RESTART_REQUEST_TERMS.some((term) =>
    textIncludesKeywordTerm(userText, term),
  );
}

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

  validate: async (runtime, message, _state) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }

    return isExplicitRestartRequest(message);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may restart the agent.",
      };
    }

    // Guard: only restart when the user explicitly asked. The runtime
    // doesn't call validate before handler, and the LLM can fuzzy-match
    // RESTART_AGENT from action loops or stray text fragments. Without
    // this guard the agent can self-restart mid-task.
    if (!isExplicitRestartRequest(message)) {
      return { success: false, text: "" };
    }

    // This action declares parameters, so the runtime provides HandlerOptions.
    const params = (options as HandlerOptions | undefined)?.parameters as
      | { reason?: string }
      | undefined;
    const reason = params?.reason;

    const restartText = reason ? `Restarting… (${reason})` : "Restarting…";

    logger.info(`[eliza] ${restartText}`);

    // Persist a "Restarting…" memory so it shows up in the message log.
    const restartMemory: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: restartText,
        source: "eliza",
        type: "system",
      },
    };
    await runtime.createMemory(restartMemory, "messages");

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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please bounce yourself — I just changed a config file.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Restarting… (config reload)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "/restart",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Restarting…",
        },
      },
    ],
  ] as ActionExample[][],
};
