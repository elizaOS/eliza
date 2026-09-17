import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

declare const process: { env?: Record<string, string | undefined> } | undefined;

export const securityStatusProvider: Provider = {
  name: "SECURITY_STATUS",
  description:
    "Provides active security gate guardrail status and policy configuration.",

  async get(
    runtime: IAgentRuntime,
    _message?: Memory,
    _state?: State,
  ): Promise<ProviderResult> {
    const env = process?.env ?? {};
    const configuredGateUrl =
      runtime.getSetting("SECURITY_GATE_URL") || env.SECURITY_GATE_URL;

    const mode = configuredGateUrl
      ? `Remote Oracle (${configuredGateUrl})`
      : "Local Deterministic Guard (Zero Network)";

    return {
      text:
        "--- [ACTIVE SECURITY GATE STATUS] ---\n" +
        `Mode: ${mode}\n` +
        "Inspection: Local Regex Guardrails & Prompt Injection Rules Enabled\n" +
        "Policy: Deterministic sub-millisecond execution\n" +
        "Enforcement: High-risk injection payloads and command executions are blocked.",
      data: {
        mode,
        localRulesEnabled: true,
        enforcement: "fail-closed",
      },
    };
  },
};
