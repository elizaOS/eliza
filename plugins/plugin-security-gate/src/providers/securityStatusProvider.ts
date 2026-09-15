import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

declare const process: { env?: Record<string, string | undefined> } | undefined;

export const securityStatusProvider: Provider = {
  async get(runtime: IAgentRuntime, _message?: Memory, _state?: State): Promise<string> {
    const env = typeof process !== "undefined" && process?.env ? process.env : {};
    const configuredGateUrl = runtime.getSetting("SECURITY_GATE_URL") || env.SECURITY_GATE_URL;

    const mode = configuredGateUrl ? `Remote Oracle (${configuredGateUrl})` : "Local Deterministic Guard (Zero Network)";

    return (
      "--- [ACTIVE SECURITY GATE STATUS] ---\n" +
      `Mode: ${mode}\n` +
      "Inspection: Local AST Hazard & Prompt Injection Rules Enabled\n" +
      "Policy: Deterministic sub-millisecond execution\n" +
      "Enforcement: High-risk injection payloads and command executions are blocked."
    );
  },
};
