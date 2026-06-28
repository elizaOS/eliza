/**
 * OrchestratorView — the single GUI/XR/TUI component for the Orchestrator
 * surface.
 *
 * GUI/XR render the full rich {@link OrchestratorWorkbench} (the diff/timeline
 * workbench with its own live data, SSE, inspector, and mutations) through the
 * spatial {@link Escape} hatch; TUI renders the degraded
 * {@link OrchestratorSpatialView} summary instead. One authored component, both
 * surfaces, no separate app-shell page. The live terminal surface is driven by
 * the host-pushed snapshot in `register-terminal-view.tsx`; the `tui` fallback
 * here is the statusless landing for hosts that evaluate this wrapper directly.
 */

import { Escape, SpatialSurface } from "@elizaos/ui/spatial";
import {
  EMPTY_ORCHESTRATOR_SNAPSHOT,
  OrchestratorSpatialView,
} from "./components/OrchestratorSpatialView.tsx";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench.tsx";

export function OrchestratorView() {
  return (
    <SpatialSurface>
      <Escape
        width="100%"
        height="100%"
        tui={<OrchestratorSpatialView snapshot={EMPTY_ORCHESTRATOR_SNAPSHOT} />}
      >
        <OrchestratorWorkbench />
      </Escape>
    </SpatialSurface>
  );
}
