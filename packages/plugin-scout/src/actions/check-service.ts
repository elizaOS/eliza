import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { formatFlagsForDisplay } from "../utils/flag-interpreter.js";
import { extractDomain } from "../utils/domain.js";
import { getScoutClient } from "../runtime-store.js";

export const checkServiceAction: Action = {
  name: "CHECK_SERVICE_TRUST",
  similes: [
    "CHECK_SERVICE",
    "SERVICE_TRUST",
    "IS_SERVICE_SAFE",
    "SCOUT_SCORE",
    "TRUST_SCORE",
    "CHECK_X402_SERVICE",
  ],
  description:
    "Check the trust score of an x402 service using Scout. Use when a user asks about the safety or trustworthiness of a domain or service URL.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = message.content.text || "";
    return extractDomain(text) !== null;
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
      callback?.({ text: "I couldn't find a domain in your message. Please provide a domain like 'questflow.ai'." });
      return { success: false };
    }

    const client = getScoutClient(runtime);
    if (!client) {
      callback?.({ text: "Scout plugin is not properly initialized." });
      return { success: false };
    }

    try {
      const result = await client.getServiceScore(domain);

      const { score, level, dimensions, recommendation, endpointHealth, fidelity, flags, serviceInfo } = result;

      const lines = [
        `**Scout Trust Score for ${domain}**: ${score}/100 (${level})`,
        "",
        `**Verdict**: ${recommendation.verdict} - ${recommendation.message}`,
        `**Max Transaction**: $${recommendation.maxTransaction}`,
        "",
        "**Trust Pillars**:",
        `- Contract Clarity: ${dimensions.contractClarity}/100`,
        `- Availability: ${dimensions.availability}/100`,
        `- Response Fidelity: ${dimensions.responseFidelity}/100`,
        `- Identity Safety: ${dimensions.identitySafety}/100`,
      ];

      if (endpointHealth) {
        lines.push("", `**Endpoint Health**: ${endpointHealth.status} (${endpointHealth.latencyMs}ms)`);
      }
      if (fidelity && fidelity.score != null) {
        const checksInfo = fidelity.checksTotal != null ? ` (${fidelity.checksTotal} checks)` : "";
        lines.push(`**Fidelity Score**: ${fidelity.score}/100${checksInfo}`);
      }

      if (serviceInfo.priceUSD > 0) {
        lines.push(`**Price**: $${serviceInfo.priceUSD} (${serviceInfo.network})`);
      }

      if (flags && flags.length > 0) {
        lines.push("", `**Flags**: ${formatFlagsForDisplay(flags)}`);
      }

      const response = lines.join("\n");
      callback?.({ text: response });

      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err: any) {
      const msg = err.statusCode === 404
        ? `Service "${domain}" was not found in Scout's database.`
        : `Failed to check service trust: ${err.message}`;
      callback?.({ text: msg });
      return { success: false };
    }
  },

  examples: [
    [
      { name: "User", content: { text: "Is questflow.ai trustworthy?" } },
    ],
    [
      { name: "User", content: { text: "Check the trust score for api.example.com" } },
    ],
  ],
};