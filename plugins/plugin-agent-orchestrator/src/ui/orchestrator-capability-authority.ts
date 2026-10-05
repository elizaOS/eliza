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
