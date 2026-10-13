import {
  type IAgentRuntime,
  type Memory,
  type State,
  type Provider,
  type ProviderResult,
  type ProviderExecutionContext,
  logger,
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
    const mode = config.serviceUrl ? "remote" : "local";
    const statusText = `CanaryGuard status: ${CanaryGuardState.lastStatus} | mode: ${mode} | scans: ${CanaryGuardState.scansCount}`;

    // Report status via structured logger rather than injecting telemetry noise into the model prompt context
    logger.debug("[CanaryGuard]", statusText);

    return {
      // Intentionally empty text to keep model prompt clean and avoid exposing defenses to prompt injectors
      text: "",
      data: {
        mode: CanaryGuardState.mode,
        scansCount: CanaryGuardState.scansCount,
        threatsNeutralized: CanaryGuardState.threatsNeutralized,
        lastStatus: CanaryGuardState.lastStatus,
      },
    };
  },
};
