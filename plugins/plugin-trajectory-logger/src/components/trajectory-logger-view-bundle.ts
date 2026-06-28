// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`TrajectoryLoggerView`,
// `interact`). Kept separate from TrajectoryLoggerView.tsx so that file exports
// only React components and stays Fast-Refresh-compatible.
export { interact } from "./TrajectoryLoggerView.interact.ts";
export { TrajectoryLoggerView } from "./TrajectoryLoggerView.tsx";
