/**
 * Universal slash-command contribution (#8790, #8798).
 *
 * The task-coordinator plugin owns the `orchestrator` view, so it contributes a
 * view-scoped slash command for that view through the standard command system:
 *
 *   - `registerOrchestratorCommands(agentId)` registers a `CommandDefinition`
 *     into the per-runtime registry of `@elizaos/plugin-commands`. The command
 *     is `views`-scoped to `orchestrator`, so it appears in `GET /api/commands`
 *     only while the orchestrator view is the active surface (#8798), and it is
 *     `target: { kind: "agent" }` so every surface routes it to this plugin's
 *     deterministic handler action.
 *   - `orchestratorStatusCommandAction` is that handler: a slash-only `Action`
 *     whose `validate()` matches `/orchestrator-status` and whose `handler()`
 *     returns a deterministic status reply — no LLM improvisation.
 *
 * This is the same contract the built-in commands and the connector bridges use;
 * registering it here proves a non-core, view-owning plugin can light up the
 * universal command surface end to end.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import {
  detectCommand,
  hasCommand,
  registerCommand,
  useRuntime,
} from "@elizaos/plugin-commands";

/** The orchestrator view id this command is scoped to. */
export const ORCHESTRATOR_VIEW_ID = "orchestrator";

/** Canonical key + handler-action name for the orchestrator status command. */
export const ORCHESTRATOR_STATUS_COMMAND_KEY = "orchestrator-status";
export const ORCHESTRATOR_STATUS_COMMAND_ACTION = "ORCHESTRATOR_STATUS_COMMAND";

/**
 * Register the task-coordinator's view-scoped slash commands into the active
 * per-runtime command registry. Call after `@elizaos/plugin-commands` has run
 * `initForRuntime(agentId)` for this runtime (it boots before app plugins).
 */
export function registerOrchestratorCommands(agentId: string): void {
  useRuntime(agentId);
  registerCommand({
    key: ORCHESTRATOR_STATUS_COMMAND_KEY,
    nativeName: ORCHESTRATOR_STATUS_COMMAND_KEY,
    description: "Show orchestrator status (in the orchestrator view)",
    textAliases: ["/orchestrator-status"],
    scope: "both",
    category: "docks",
    icon: "Layers",
    surfaces: ["gui", "tui"],
    views: [ORCHESTRATOR_VIEW_ID],
    target: { kind: "agent", action: ORCHESTRATOR_STATUS_COMMAND_ACTION },
    acceptsArgs: false,
  });
}

/**
 * Deterministic handler for `/orchestrator-status`. Slash-only `validate()`
 * (never intercepts conversational text) and a fixed reply so the command
 * behaves identically on every surface.
 */
export const orchestratorStatusCommandAction: Action = {
  name: ORCHESTRATOR_STATUS_COMMAND_ACTION,
  description: "Report the orchestrator surface status as a slash command.",
  similes: ["/orchestrator-status"],
  suppressEarlyReply: true,
  suppressPostActionContinuation: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text ?? "";
    if (!hasCommand(text)) return false;
    useRuntime(runtime.agentId);
    const detection = detectCommand(text);
    return (
      detection.isCommand &&
      detection.command?.key === ORCHESTRATOR_STATUS_COMMAND_KEY
    );
  },
  handler: async (_runtime, _message, _state, _options, callback) => {
    const reply = "Orchestrator is online.";
    if (callback) await callback({ text: reply, source: "command" });
    return { success: true, text: reply };
  },
};
