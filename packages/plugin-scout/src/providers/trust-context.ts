import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { formatFlagsForDisplay } from "../utils/flag-interpreter.js";
import { extractDomains } from "../utils/domain.js";
import { getScoutClient } from "../runtime-store.js";

export const trustContextProvider: Provider = {
  name: "scout_trust_context",
  description:
    "Injects trust intelligence for x402 service domains mentioned in the conversation. Provides the LLM with trust scores, verdicts, and flags so it can make trust-aware decisions.",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ) => {
    const client = getScoutClient(runtime);
    if (!client) {
      return { text: "" };
    }

    const text = message.content.text || "";
    const domains = extractDomains(text);
    if (domains.length === 0) {
      return { text: "" };
    }

    const contextParts: string[] = [];
    const trustData: Record<string, any> = {};

    // Score up to 3 domains to avoid excessive API calls per message
    const domainsToCheck = domains.slice(0, 3);

    for (const domain of domainsToCheck) {
      try {
        const result = await client.getServiceScore(domain);
        const { score, level, dimensions, recommendation, endpointHealth, flags } = result;

        trustData[domain] = {
          score,
          level,
          verdict: recommendation.verdict,
          maxTransaction: recommendation.maxTransaction,
          health: endpointHealth?.status ?? "UNKNOWN",
        };

        let contextLine =
          `Trust context for ${domain}: Score ${score}/100 (${level}). ` +
          `Pillars: Contract ${dimensions.contractClarity}, Availability ${dimensions.availability}, ` +
          `Fidelity ${dimensions.responseFidelity}, Safety ${dimensions.identitySafety}. ` +
          `Verdict: ${recommendation.verdict} (max $${recommendation.maxTransaction}).`;
        if (endpointHealth) {
          contextLine += ` Health: ${endpointHealth.status} (${endpointHealth.latencyMs}ms).`;
        }
        if (flags.length > 0) {
          contextLine += ` ${formatFlagsForDisplay(flags)}`;
        }
        contextParts.push(contextLine);
      } catch {
        contextParts.push(`Trust context for ${domain}: Unable to fetch (service may not be in Scout's database).`);
      }
    }

    return {
      values: { scoutTrustData: trustData },
      data: { scoutTrustData: trustData },
      text: contextParts.join("\n"),
    };
  },
};