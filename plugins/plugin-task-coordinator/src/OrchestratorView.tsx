/**
 * OrchestratorView — GUI route wrapper for the Orchestrator surface.
 *
 * The compact task stream orients users before the rich workbench takes over
 * detailed task state, inspection, and mutations.
 */

import { OrchestratorTaskWidget } from "@elizaos/ui";
import { Escape } from "@elizaos/ui/spatial";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench.tsx";

export function OrchestratorView() {
  return (
    <Escape width="100%" height="100%">
      <div className="flex h-full min-h-0 flex-col">
        <div
          className="shrink-0 border-b border-border/40 bg-bg/70 px-4"
          data-testid="orchestrator-live-task-stream"
        >
          <OrchestratorTaskWidget />
        </div>
        <div className="min-h-0 flex-1">
          <OrchestratorWorkbench />
        </div>
      </div>
    </Escape>
  );
}
