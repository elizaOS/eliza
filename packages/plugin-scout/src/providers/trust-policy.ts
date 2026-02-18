import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { getScoutConfig } from "../runtime-store.js";

export const trustPolicyProvider: Provider = {
  name: "scout_trust_policy",
  description:
    "Injects the agent's Scout trust policy - minimum score thresholds, auto-reject flags, and risk tolerance - so the LLM understands what level of trust is required.",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ) => {
    const config = getScoutConfig(runtime);
    if (!config) {
      return { text: "" };
    }

    const policyText = [
      `Trust policy: Minimum service trust score ${config.minServiceScore}/100.`,
      `Auto-reject flags: ${config.autoRejectFlags.join(", ")}.`,
      `Services with verdicts below USABLE are blocked from transactions.`,
    ].join(" ");

    return {
      values: {
        scoutMinScore: config.minServiceScore,
        scoutAutoRejectFlags: config.autoRejectFlags,
      },
      data: {
        scoutPolicy: {
          minServiceScore: config.minServiceScore,
          autoRejectFlags: config.autoRejectFlags,
        },
      },
      text: policyText,
    };
  },
};