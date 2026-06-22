// Vite view-bundle entry. Re-exports the unified tri-modal view wrappers the
// manifest declares (`TaskCoordinatorView`, `OrchestratorView`) plus the shared
// `interact` capability handler, so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads. Kept separate from the view
// component files so they export only React components and stay
// Fast-Refresh-compatible.
//
// The legacy GUI surfaces (`CodingAgentTasksPanel`, `OrchestratorWorkbench`)
// reach their mounts through other paths — the app-core slot registry
// (register-slots.ts) and the app-shell page registry (register.ts) — not this
// bundle, so they are intentionally absent here.
export { interact } from "./CodingAgentTasksPanel.interact";
export { OrchestratorView } from "./OrchestratorView";
export { TaskCoordinatorView } from "./TaskCoordinatorView";
