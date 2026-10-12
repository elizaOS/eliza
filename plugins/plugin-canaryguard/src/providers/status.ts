import { type Provider, type IAgentRuntime, type Memory, type State } from "@elizaos/core";

export const canaryGuardProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
    return "CanaryGuard 402 deterministic prompt-injection firewall is ACTIVE (Base mainnet / x402). Untrusted inputs are screened for instruction overrides and wallet drain attempts.";
  },
};
