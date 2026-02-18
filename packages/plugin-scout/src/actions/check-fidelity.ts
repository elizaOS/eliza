import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { extractDomain } from "../utils/domain.js";
import { getScoutClient } from "../runtime-store.js";

export const checkFidelityAction: Action = {
  name: "CHECK_FIDELITY",
  similes: [
    "FIDELITY_CHECK",
    "X402_COMPLIANCE",
    "PROTOCOL_CHECK",
    "VERIFY_SERVICE",
  ],
  description:
    "Probe an x402 service's fidelity - does it actually follow the protocol and deliver what it advertises? Use when a user wants to verify protocol compliance or contract consistency.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = (message.content.text || "").toLowerCase();
    const hasFidelityKeyword = /\b(fidelity|protocol|compliance|x402|verify|probe)\b/.test(text);
    return hasFidelityKeyword && extractDomain(message.content.text || "") !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const text = message.content.text || "";
    const domain = extractDomain(text);
    if (!domain) {
      callback?.({ text: "Please provide a domain to check fidelity for." });
      return { success: false };
    }

    const client = getScoutClient(runtime);
    if (!client) {
      callback?.({ text: "Scout plugin is not properly initialized." });
      return { success: false };
    }

    const fresh = /\bfresh\b|\bforce\b|\bnew\b/.test(text.toLowerCase());

    try {
      const result = await client.getServiceFidelity(domain, fresh);
      const { fidelityScore, level, layers, flags, checksTotal, lastChecked } = result;

      const lines = [
        `**Fidelity Report for ${domain}**: ${fidelityScore}/100 (${level})`,
        "",
        "**Three-Layer Analysis**:",
        `- Protocol Compliance: ${layers.protocolCompliance.score}/100 - Does it return proper x402 responses?`,
        `- Contract Consistency: ${layers.contractConsistency.score}/100 - Does the actual response match what's advertised?`,
        `- Response Structure: ${layers.responseStructure.score}/100 - Is the response well-formed and documented?`,
        "",
        `**Total Checks**: ${checksTotal ?? "N/A"}`,
        `**Last Checked**: ${lastChecked}`,
      ];

      if (flags && flags.length > 0) {
        lines.push("", `**Flags**: ${flags.join(", ")}`);
      }

      if (fresh) {
        lines.push("", "_Fresh probe performed (bypassed cache)._");
      }

      callback?.({ text: lines.join("\n") });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err: any) {
      const msg = err.statusCode === 404
        ? `Service "${domain}" was not found in Scout's database.`
        : err.statusCode === 422
        ? `Service "${domain}" has no endpoint URL available for fidelity probing.`
        : `Fidelity check failed: ${err.message}`;
      callback?.({ text: msg });
      return { success: false };
    }
  },

  examples: [
    [
      { name: "User", content: { text: "Does questflow.ai follow the x402 protocol?" } },
    ],
  ],
};