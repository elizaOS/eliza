/**
 * Vite view-bundle entry for the trajectory logger.
 * It re-exports the unified spatial view and capability handler under the named exports the elizaOS view loader reads.
 */

export { interact } from "./TrajectoryLoggerView.interact.ts";
export { TrajectoryLoggerView } from "./TrajectoryLoggerView.tsx";
