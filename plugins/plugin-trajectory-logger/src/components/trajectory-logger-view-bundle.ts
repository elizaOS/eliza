// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`TrajectoryLoggerView`,
// `TrajectoryLoggerTuiView`, `interact`). Kept separate from
// TrajectoryLoggerView.tsx so that file exports only React components and stays
// Fast-Refresh-compatible.
export {
  TrajectoryLoggerTuiView,
  TrajectoryLoggerView,
} from "./TrajectoryLoggerView";
export { interact } from "./TrajectoryLoggerView.interact";
