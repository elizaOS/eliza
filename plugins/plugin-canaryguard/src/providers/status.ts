import { type Provider, type IAgentRuntime, type Memory, type State } from "@elizaos/core";
import { CanaryGuardState } from "../engine/state";
import { resolveConfig } from "../actions/sanitize";

export const canaryGuardProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message?: Memory, _state?: State): Promise<string> => {
    const config = resolveConfig(runtime);

    if (CanaryGuardState.lastStatus === "error") {
      return `CanaryGuard prompt-injection firewall is DEGRADED (remote unreachable: ${CanaryGuardState.lastError}, active in local fallback mode).`;
    }

    if (config.serviceUrl) {
      return `CanaryGuard prompt-injection firewall is ACTIVE (Remote Oracle Mode: ${config.serviceUrl}, Scans: ${CanaryGuardState.scansCount}).`;
    }

    return `CanaryGuard prompt-injection firewall is ACTIVE (Local Deterministic Engine: offline, zero latency, Scans: ${CanaryGuardState.scansCount}).`;
  },
};
