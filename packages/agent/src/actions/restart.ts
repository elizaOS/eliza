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
  isSelfEditEnabled,
  textIncludesKeywordTerm,
} from "@elizaos/shared";
import { requestRestart } from "../runtime/restart.js";

/** Small delay (ms) before restarting so the response has time to flush. */
const SHUTDOWN_DELAY_MS = 1_500;
const MAX_RESTART_REASON_CHARS = 240;

/**
 * Origin of a restart request. The dev-mode self-edit flow tags its restart
 * with `"self-edit"` so the action can refuse it when the runtime is not in
 * self-edit dev-mode (see {@link isSelfEditEnabled}). Other restarts (`"user"`
 * for explicit `/restart`, `"plugin-install"` for post-install reloads) are
 * unaffected by the gate.
 */
export type RestartSource = "self-edit" | "user" | "plugin-install";

const RESTART_SOURCES: ReadonlySet<RestartSource> = new Set([
  "self-edit",
  "user",
  "plugin-install",
]);

function parseRestartSource(value: unknown): RestartSource | undefined {
  if (typeof value !== "string") return undefined;
  return RESTART_SOURCES.has(value as RestartSource)
    ? (value as RestartSource)
    : undefined;
}

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
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },

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
  descriptionCompressed:
    "restart agent process stop runtime, rebuild source file change, relaunch pick up new code, config, plugin",

  validate: async (_runtime, message, _state) => {
    return isExplicitRestartRequest(message);
  },

  handler: async (runtime, message, _state, options) => {
    // Guard: only restart when the user explicitly asked. The runtime
    // doesn't call validate before handler, and the LLM can fuzzy-match
    // RESTART_AGENT from action loops or stray text fragments. Without
    // this guard the agent can self-restart mid-task.
    if (!isExplicitRestartRequest(message)) {
      return { success: false, text: "" };
    }

    // This action declares parameters, so the runtime provides HandlerOptions.
    const params = (options as HandlerOptions | undefined)?.parameters as
      | { reason?: string; source?: string }
      | undefined;
    const reason =
      typeof params?.reason === "string"
        ? params.reason.slice(0, MAX_RESTART_REASON_CHARS)
        : undefined;
    const source = parseRestartSource(params?.source);

    // Self-edit-driven restarts must only execute when the dev-mode gate is
    // open. Other restart sources (user-issued, plugin install) bypass the
    // gate so production users can still bounce the agent normally.
    if (source === "self-edit" && !isSelfEditEnabled()) {
      const refusalText =
        "Refused: self-edit restart requires dev mode " +
        "(MILADY_ENABLE_SELF_EDIT=1 plus NODE_ENV!=production or MILADY_DEV_MODE=1).";
      logger.warn(`[eliza] ${refusalText}`);
      return {
        success: false,
        text: refusalText,
        data: { reason, source, refused: "self-edit-not-enabled" },
      };
    }

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
      data: { reason, source },
    };
  },

  parameters: [
    {
      name: "reason",
      description: "Optional reason for the restart (logged for diagnostics).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "source",
      description:
        "Origin of the restart request. 'self-edit' is gated by " +
        "isSelfEditEnabled(); 'user' and 'plugin-install' bypass the gate.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["self-edit", "user", "plugin-install"] as const,
      },
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
