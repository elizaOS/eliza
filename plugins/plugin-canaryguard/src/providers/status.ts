import type {
  IAgentRuntime,
  Memory,
  State,
  Provider,
  ProviderResult,
  ProviderExecutionContext,
} from "@elizaos/core";
import { CanaryGuardState } from "../engine/state";
import { resolveConfig } from "../actions/sanitize";

export const canaryGuardProvider: Provider = {
  name: "canaryguard",
  description: "CanaryGuard heuristic detector and wallet defense status provider",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _context?: ProviderExecutionContext
  ): Promise<ProviderResult> => {
    const config = resolveConfig(runtime);
    let statusText: string;

    if (CanaryGuardState.lastStatus === "error") {
      statusText = `CanaryGuard heuristic detector is DEGRADED (remote unreachable: ${CanaryGuardState.lastError}, active in local fallback mode).`;
    } else if (config.serviceUrl) {
      statusText = `CanaryGuard heuristic detector is ACTIVE (Remote Oracle Mode: ${config.serviceUrl}, Scans: ${CanaryGuardState.scansCount}).`;
    } else {
      statusText = `CanaryGuard heuristic detector is ACTIVE (Local Deterministic Engine: offline, zero latency, Scans: ${CanaryGuardState.scansCount}).`;
    }

    return {
      text: statusText,
      data: {
        mode: CanaryGuardState.mode,
        scansCount: CanaryGuardState.scansCount,
        threatsNeutralized: CanaryGuardState.threatsNeutralized,
        lastStatus: CanaryGuardState.lastStatus,
      },
    };
  },
};
