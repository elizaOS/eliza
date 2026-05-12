/**
 * Sandbox-build stub for the TASKS coding-agent surface.
 *
 * Store-distributed builds (Mac App Store, Microsoft Store, Flathub) run in
 * an OS sandbox that forbids forking arbitrary user-installed binaries. The
 * orchestrator's spawn paths (claude / codex / opencode CLIs via PTY) are
 * therefore not viable in those builds, so we replace the TASKS action with
 * a single stub that explains the limitation and points the user at the
 * direct-download artifact.
 *
 * Behavior:
 *   - validate(): always true — we want this stub to win whenever the
 *     planner reaches for any coding-agent simile under sandbox.
 *   - handler(): returns a single user-facing error result; no spawn
 *     attempt, no workspace allocation, no PTY.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { buildStoreVariantBlockedMessage } from "@elizaos/core";
import type { OrchestratorTerminalSupport } from "../services/terminal-capabilities.js";

const BLOCKED_MESSAGE = buildStoreVariantBlockedMessage("Coding agents");

type UnsupportedStubOptions = {
  message: string;
  reason: string;
  description?: string;
};

function buildTasksUnsupportedAction({
  message,
  reason,
  description = "Coding-agent surface is unavailable in this runtime environment.",
}: UnsupportedStubOptions): Action & {
  suppressPostActionContinuation: true;
} {
  return {
    name: "TASKS",
    description,
    contexts: ["tasks", "code", "automation", "agent_internal", "connectors"],
    roleGate: { minRole: "USER" },
    suppressPostActionContinuation: true,
    similes: [...TASKS_STUB_SIMILES],
    examples: [],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      _options?: unknown,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      if (callback) {
        await callback({
          text: message,
          actions: ["TASKS"],
        });
      }
      return {
        success: false,
        text: message,
        data: {
          actionName: "TASKS",
          reason,
        },
      };
    },
  };
}

const TASKS_STUB_SIMILES = [
  "CREATE_AGENT_TASK",
  "CREATE_TASK",
  "START_CODING_TASK",
  "LAUNCH_CODING_TASK",
  "RUN_CODING_TASK",
  "START_AGENT_TASK",
  "SPAWN_AND_PROVISION",
  "CODE_THIS",
  "LAUNCH_TASK",
  "SPAWN_AGENT",
  "SPAWN_CODING_AGENT",
  "START_CODING_AGENT",
  "LAUNCH_CODING_AGENT",
  "CREATE_CODING_AGENT",
  "SPAWN_CODER",
  "RUN_CODING_AGENT",
  "SPAWN_SUB_AGENT",
  "START_TASK_AGENT",
  "CREATE_AGENT",
  "SEND_TO_AGENT",
  "SEND_TO_CODING_AGENT",
  "MESSAGE_CODING_AGENT",
  "STOP_AGENT",
  "STOP_CODING_AGENT",
  "KILL_CODING_AGENT",
  "TERMINATE_AGENT",
  "LIST_AGENTS",
  "LIST_CODING_AGENTS",
  "CANCEL_TASK",
  "STOP_TASK",
  "TASK_HISTORY",
  "TASK_CONTROL",
  "TASK_SHARE",
  "PROVISION_WORKSPACE",
  "FINALIZE_WORKSPACE",
  "MANAGE_ISSUES",
  "ARCHIVE_CODING_TASK",
  "REOPEN_CODING_TASK",
] as const;

export const tasksSandboxStubAction: Action & {
  suppressPostActionContinuation: true;
} = buildTasksUnsupportedAction({
  message: BLOCKED_MESSAGE,
  reason: "STORE_BUILD_BLOCKED",
  description:
    "Coding-agent surface (disabled in store builds — install the direct download to enable).",
});

export function createTerminalUnsupportedTasksAction(
  support: OrchestratorTerminalSupport,
): Action & { suppressPostActionContinuation: true } {
  const reason =
    support.reason === "vanilla_mobile"
      ? "MOBILE_TERMINAL_UNSUPPORTED"
      : support.reason === "not_local_yolo"
        ? "AOSP_TERMINAL_REQUIRES_LOCAL_YOLO"
        : support.reason === "missing_shell"
          ? "AOSP_TERMINAL_MISSING_SHELL"
          : "TERMINAL_UNSUPPORTED";
  return buildTasksUnsupportedAction({
    message:
      support.message ??
      "Coding agents are unavailable because local terminal capabilities are not supported in this runtime.",
    reason,
  });
}
