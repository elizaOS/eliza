import type {
  ActionResult,
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { potCacheGet } from "../actions/generatePot.js";

/**
 * Evaluates whether recent agent actions have adequate Proof-of-Time coverage.
 * Surfaces a warning if trade-related messages lack PoT attestation.
 */
export const potEvaluator: Evaluator = {
  name: "POT_COVERAGE_EVALUATOR",
  similes: ["CHECK_POT_COVERAGE", "AUDIT_TEMPORAL_ATTESTATION"],
  description:
    "Checks whether recent trade or transaction messages have associated " +
    "Proof-of-Time tokens. Flags uncovered transactions for remediation.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    // Only evaluate messages that look trade/transaction related
    const text = (message.content?.text ?? "").toLowerCase();
    const tradeKeywords = [
      "trade", "swap", "buy", "sell", "submit", "execute",
      "transaction", "transfer", "order", "sign", "broadcast",
    ];
    return tradeKeywords.some((kw) => text.includes(kw));
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ActionResult | void | undefined> => {
    // Check if a PoT was generated for this message using module-level cache
    const potKey = `openttt:pot:${message.id}`;
    const cached = potCacheGet(potKey);

    if (cached) {
      try {
        const pot = JSON.parse(cached);
        const age_ms = Date.now() - pot.timestamp;
        const ageLabel = age_ms < 60000
          ? `${Math.round(age_ms / 1000)}s ago`
          : `${Math.round(age_ms / 60000)}m ago`;

        console.log(
          `[POT_COVERAGE_EVALUATOR] ✓ Transaction has PoT coverage. ` +
          `Issued: ${ageLabel}, Sources: ${pot.sources.join(", ")}, ` +
          `Consensus: ${pot.consensus ? "YES" : "DEGRADED"}.`
        );
        return;
      } catch {
        // fall through to missing case
      }
    }

    console.warn(
      `[POT_COVERAGE_EVALUATOR] ⚠ No Proof-of-Time found for this transaction. ` +
      `Consider calling GENERATE_POT before submitting trades to ensure ` +
      `tamper-evident temporal attestation.`
    );
  },

  examples: [
    {
      prompt: "Agent is about to submit a swap transaction",
      messages: [
        {
          name: "user1",
          content: { text: "Execute the swap for 1 ETH to USDC" },
        },
      ],
      outcome:
        "[POT_COVERAGE_EVALUATOR] ⚠ No Proof-of-Time found for this transaction.",
    },
    {
      prompt: "Agent generated PoT before trade",
      messages: [
        {
          name: "user1",
          content: { text: "Submit the buy order" },
        },
      ],
      outcome:
        "[POT_COVERAGE_EVALUATOR] ✓ Transaction has PoT coverage. Issued: 3s ago, Sources: NIST, Apple, Google, Cloudflare, Consensus: YES.",
    },
  ],
};
