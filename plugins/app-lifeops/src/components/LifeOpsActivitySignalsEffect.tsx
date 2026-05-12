import { useApp } from "@elizaos/ui";
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
