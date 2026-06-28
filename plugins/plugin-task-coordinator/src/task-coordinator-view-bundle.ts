// Vite view-bundle entry. Re-exports the unified tri-modal view wrappers the
// manifest declares (`TaskCoordinatorView`, `OrchestratorView`) plus the shared
// `interact` capability handler, so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads. Kept separate from the view
// component files so they export only React components and stay
// Fast-Refresh-compatible.
//
// `OrchestratorWorkbench` is the rich GUI/XR surface of `OrchestratorView` (its
// `Escape` child) so it ships inside this bundle transitively, not as a named
// export. `CodingAgentTasksPanel` reaches its mount through the app-core slot
// registry (register-slots.ts → the built-in /apps/tasks page), so it is
// intentionally absent here.
export { interact } from "./CodingAgentTasksPanel.interact";
export { OrchestratorView } from "./OrchestratorView";
export { TaskCoordinatorView } from "./TaskCoordinatorView";
