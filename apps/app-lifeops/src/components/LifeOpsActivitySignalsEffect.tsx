/**
 * Effect-only component that captures LifeOps activity signals (page
 * visibility, app lifecycle, desktop power state, mobile health) while the
 * app runtime is ready.
 *
 * Renders nothing. Mount as a sibling of `<App />` in the host entry point:
 *
 *   <LifeOpsActivitySignalsEffect />
 *   <App />
 *
 * Self-computes its enabled flag from `useApp()` so callers don't need to
 * wire anything up.
 */

import { useApp } from "@elizaos/app-core/state";
import { useLifeOpsActivitySignals } from "../hooks/useLifeOpsActivitySignals.js";

export function LifeOpsActivitySignalsEffect(): null {
  const { startupCoordinator, agentStatus, backendConnection } = useApp();
  const enabled =
    startupCoordinator.phase === "ready" &&
    agentStatus?.state === "running" &&
    backendConnection?.state === "connected";
  useLifeOpsActivitySignals(enabled);
  return null;
}
