// Vite view-bundle entry. Re-exports every view component the manifest declares
// (`CodingAgentTasksPanel`, `TaskCoordinatorTuiView`, `OrchestratorWorkbench`,
// `OrchestratorTuiView`) plus the shared `interact` capability handler, so the
// built bundle (dist/views/bundle.js) exposes the same named exports the view
// loader reads. Kept separate from CodingAgentTasksPanel.tsx so that file
// exports only React components and stays Fast-Refresh-compatible.
export {
  CodingAgentTasksPanel,
  OrchestratorTuiView,
  TaskCoordinatorTuiView,
} from "./CodingAgentTasksPanel";
export { interact } from "./CodingAgentTasksPanel.interact";
export { OrchestratorWorkbench } from "./OrchestratorWorkbench";
