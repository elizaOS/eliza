import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { extractDomains } from "../utils/domain.js";
import { getScoutClient } from "../runtime-store.js";

export const batchScoreAction: Action = {
  name: "BATCH_SCORE_SERVICES",
  similes: [
    "BATCH_SCORE",
    "SCORE_MULTIPLE",
    "COMPARE_SERVICES",
    "BULK_TRUST_CHECK",
  ],
  description:
    "Score multiple x402 services at once using Scout's batch API. Use when a user mentions multiple domains or wants to compare services.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const domains = extractDomains(message.content.text || "");
    return domains.length >= 2;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const domains = extractDomains(message.content.text || "");
    if (domains.length < 2) {
      callback?.({ text: "Please provide at least 2 domains to compare." });
      return { success: false };
    }
    if (domains.length > 20) {
      callback?.({ text: "Batch scoring supports up to 20 domains at a time." });
      return { success: false };
    }

    const client = getScoutClient(runtime);
    if (!client) {
      callback?.({ text: "Scout plugin is not properly initialized." });
      return { success: false };
    }

    try {
      const result = await client.batchScore(domains);
      const { batch, results } = result;

      const lines = [
        `**Batch Trust Scores** (${batch.scored}/${batch.total} found${batch.scored > 0 ? `, avg ${Math.round(batch.averageScore)}/100` : ""})`,
        "",
      ];

      // Sort by score descending
      const sorted = [...results].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

      for (const r of sorted) {
        if (r.score !== null) {
          const flagStr = r.flags && r.flags.length > 0 ? ` | Flags: ${r.flags.join(", ")}` : "";
          lines.push(`- **${r.domain}**: ${r.score}/100 (${r.level})${flagStr}`);
        } else {
          lines.push(`- **${r.domain}**: Not found`);
        }
      }

      if (batch.scored > 0) {
        lines.push(
          "",
          `**Distribution**: HIGH: ${batch.distribution.HIGH}, MEDIUM: ${batch.distribution.MEDIUM}, LOW: ${batch.distribution.LOW}, VERY_LOW: ${batch.distribution.VERY_LOW}`
        );
      }

      callback?.({ text: lines.join("\n") });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err: any) {
      callback?.({ text: `Batch scoring failed: ${err.message}` });
      return { success: false };
    }
  },

  examples: [
    [
      { name: "User", content: { text: "Compare questflow.ai and api.example.com" } },
    ],
  ],
};