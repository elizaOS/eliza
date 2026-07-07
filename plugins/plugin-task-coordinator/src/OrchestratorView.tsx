/**
 * OrchestratorView — the GUI component for the Orchestrator surface.
 *
 * Renders the full rich {@link OrchestratorWorkbench} (the diff/timeline
 * workbench with its own live data, SSE, inspector, and mutations) through the
 * spatial {@link Escape} hatch, with the degraded
 * {@link OrchestratorSpatialView} summary as the `Escape` fallback. One
 * authored component, no separate app-shell page.
 */

import { Escape } from "@elizaos/ui/spatial";
import {
  EMPTY_ORCHESTRATOR_SNAPSHOT,
  OrchestratorSpatialView,
} from "./components/OrchestratorSpatialView.tsx";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench.tsx";

export function OrchestratorView() {
  return (
    <Escape
      width="100%"
      height="100%"
      tui={<OrchestratorSpatialView snapshot={EMPTY_ORCHESTRATOR_SNAPSHOT} />}
    >
      <OrchestratorWorkbench />
    </Escape>
  );
}
