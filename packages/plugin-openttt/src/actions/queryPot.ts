import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { PoTToken } from "./generatePot.js";
import { potCacheGet } from "./generatePot.js";

/**
 * Returns the most recently generated PoT token for this agent,
 * or looks up a specific token by potHash if provided.
 * Useful for inspecting PoT history without triggering a new verification.
 */
export const queryPot: Action = {
  name: "QUERY_POT",
  similes: [
    "GET_POT_HISTORY",
    "SHOW_POT",
    "LIST_POT",
    "INSPECT_POT",
    "POT_STATUS",
  ],
  description:
    "Returns the cached Proof-of-Time token for this agent. " +
    "Optionally accepts a potHash to look up a specific token. " +
    "Use to inspect PoT status without generating a new token.",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult | void | undefined> => {
    try {
      const agentId = runtime.agentId ?? "unknown";
      let pot: PoTToken | null = null;

      // Try explicit potHash from options first
      const potHashArg = options?.pot_hash as string | undefined;
      const textMatch = (message.content?.text as string ?? "").match(/\b([0-9a-f]{32,})\b/i);
      const resolvedHash = potHashArg ?? textMatch?.[1];

      if (resolvedHash) {
        const cached = potCacheGet(`openttt:pot:${resolvedHash}`);
        if (cached) {
          try { pot = JSON.parse(cached) as PoTToken; } catch { pot = null; }
        }
      }

      // Fall back to last-generated pointer
      if (!pot) {
        const lastHash = potCacheGet(`openttt:last:${agentId}`);
        if (lastHash) {
          const cached = potCacheGet(`openttt:pot:${lastHash}`);
          if (cached) {
            try { pot = JSON.parse(cached) as PoTToken; } catch { pot = null; }
          }
        }
      }

      if (!pot) {
        const msg = "No PoT token found in cache. Generate one first with GENERATE_POT.";
        if (callback) {
          await callback({ text: msg, content: { pot: null } });
        }
        return { success: false, error: msg };
      }

      const age_ms = Date.now() - pot.timestamp;
      const ageLabel =
        age_ms < 60000
          ? `${Math.round(age_ms / 1000)}s ago`
          : `${Math.round(age_ms / 60000)}m ago`;

      const responseText = [
        `Cached Proof-of-Time token:`,
        ``,
        `  Issued    : ${pot.issued_at} (${ageLabel})`,
        `  Sources   : ${pot.sources.join(", ")}`,
        `  Consensus : ${pot.consensus ? "✓ CONSENSUS" : "⚠ DEGRADED"}`,
        `  Deviation : ${pot.deviation_ms}ms`,
        `  Agent     : ${pot.agent_id}`,
        `  PotHash   : ${pot.potHash}`,
        `  Nonce     : ${pot.nonce}`,
      ].join("\n");

      if (callback) {
        await callback({ text: responseText, content: { pot } });
      }
      return { success: true, text: responseText, data: { pot } };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error querying PoT";
      if (callback) {
        await callback({ text: `Failed to query PoT: ${errorMsg}`, content: { error: errorMsg } });
      }
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me the current proof of time status" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Cached Proof-of-Time token:\n\n  Issued    : 2026-03-17T07:00:00.000Z (12s ago)\n  Sources   : NIST, Apple, Google, Cloudflare\n  Consensus : ✓ CONSENSUS\n  Deviation : 87ms",
          actions: ["QUERY_POT"],
        },
      },
    ],
  ] as ActionExample[][],
};
