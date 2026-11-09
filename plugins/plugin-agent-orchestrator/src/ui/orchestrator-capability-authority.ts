/** Defines the orchestrator mutations reserved for direct human UI controls. */

export const HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS: ReadonlySet<string> =
  new Set([
    "orchestrator-pause-task",
    "orchestrator-resume-task",
    "orchestrator-pause-all",
    "orchestrator-resume-all",
    "orchestrator-delete-task",
    "orchestrator-fork-task",
    "orchestrator-update-task",
    "orchestrator-validate-task",
    "orchestrator-add-agent",
    "orchestrator-stop-agent",
  ]);

export function isHumanOnlyOrchestratorCapability(capability: string): boolean {
  return HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS.has(capability);
}

/** Task-coordinator view capabilities reserved for direct human UI controls. */
export const HUMAN_ONLY_TASK_COORDINATOR_CAPABILITY_IDS: ReadonlySet<string> =
  new Set(["stop-session"]);

export function isHumanOnlyTaskCoordinatorCapability(
  capability: string,
): boolean {
  return HUMAN_ONLY_TASK_COORDINATOR_CAPABILITY_IDS.has(capability);
}

/**
 * Terminal-pane controls that write to or stop a session. They render as
 * `data-agent-authority="human"` controls, never as agent elements.
 */
export const HUMAN_ONLY_TERMINAL_CONTROL_IDS: ReadonlySet<string> = new Set([
  "cockpit-terminal-interrupt",
  "cockpit-terminal-stop",
  "cockpit-terminal-input",
  "cockpit-terminal-send",
]);
