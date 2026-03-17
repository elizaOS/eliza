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
import { getVerifiedTime } from "../providers/timeProvider.js";

export interface VerifyResult {
  valid: boolean;
  reason: string;
  pot?: PoTToken;
  age_ms?: number;
  current_time?: number;
}

const POT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Verifies a previously generated Proof-of-Time token.
 * Checks: token existence, expiry, consensus flag, and time drift.
 * Call this AFTER receiving a trade confirmation to validate temporal integrity.
 */
export const verifyPot: Action = {
  name: "VERIFY_POT",
  similes: [
    "CHECK_PROOF_OF_TIME",
    "VALIDATE_POT",
    "VERIFY_TIMESTAMP",
    "AUDIT_TIME_PROOF",
    "CHECK_TEMPORAL_ATTESTATION",
  ],
  description:
    "Verifies a Proof-of-Time (PoT) token for a given transaction. " +
    "Checks token age, source consensus, and time drift against current " +
    "verified time. Use after a trade to confirm temporal integrity.",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult | void | undefined> => {
    try {
      // Accept pot passed directly in options, or look up by message id
      let pot: PoTToken | null = null;

      if (options?.pot && typeof options.pot === "object") {
        pot = options.pot as PoTToken;
      } else {
        // Issue 1 fix: look up by potHash first, then fall back to last-generated pointer
        const potHashArg = options?.pot_hash as string | undefined;
        // Try to extract potHash from message text (e.g. "verify pot abc123")
        const textMatch = (message.content?.text as string ?? "").match(/\b([0-9a-f]{32,})\b/i);
        const potHashFromText = textMatch?.[1];

        const resolvedHash = potHashArg ?? potHashFromText;

        if (resolvedHash) {
          const cached = potCacheGet(`openttt:pot:${resolvedHash}`);
          if (cached) {
            try { pot = JSON.parse(cached) as PoTToken; } catch { pot = null; }
          }
        }

        // Fall back to last-generated pointer for this agent
        if (!pot) {
          const agentId = (_runtime.agentId ?? "unknown") as string;
          const lastHash = potCacheGet(`openttt:last:${agentId}`);
          if (lastHash) {
            const cached = potCacheGet(`openttt:pot:${lastHash}`);
            if (cached) {
              try { pot = JSON.parse(cached) as PoTToken; } catch { pot = null; }
            }
          }
        }
      }

      if (!pot) {
        const result: VerifyResult = {
          valid: false,
          reason: "No PoT token found for this transaction. Generate one first with GENERATE_POT.",
        };
        if (callback) {
          await callback({
            text: `Verification FAILED: ${result.reason}`,
            content: { result },
          });
        }
        return { success: false, error: result.reason, data: { result } };
      }

      // Check age
      const vt = await getVerifiedTime();
      const age_ms = vt.timestamp - pot.timestamp;

      if (age_ms > POT_MAX_AGE_MS) {
        const result: VerifyResult = {
          valid: false,
          reason: `PoT token expired. Age: ${Math.round(age_ms / 1000)}s (max: ${POT_MAX_AGE_MS / 1000}s).`,
          pot,
          age_ms,
          current_time: vt.timestamp,
        };
        if (callback) {
          await callback({
            text: `Verification FAILED: ${result.reason}`,
            content: { result },
          });
        }
        return { success: false, error: result.reason, data: { result } };
      }

      if (age_ms < 0) {
        const result: VerifyResult = {
          valid: false,
          reason: `PoT token timestamp is in the future. Possible clock manipulation detected.`,
          pot,
          age_ms,
          current_time: vt.timestamp,
        };
        if (callback) {
          await callback({
            text: `Verification FAILED: ${result.reason}`,
            content: { result },
          });
        }
        return { success: false, error: result.reason, data: { result } };
      }

      // Warn if consensus was degraded at issuance
      const consensusWarning = pot.consensus
        ? ""
        : "\n⚠ Warning: PoT was issued under degraded consensus (fewer than 2 time sources responded).";

      const result: VerifyResult = {
        valid: true,
        reason: "PoT token is valid.",
        pot,
        age_ms,
        current_time: vt.timestamp,
      };

      const responseText = [
        `Proof-of-Time verification PASSED.`,
        ``,
        `Token Summary:`,
        `  Issued    : ${pot.issued_at}`,
        `  Age       : ${Math.round(age_ms / 1000)}s`,
        `  Sources   : ${pot.sources.join(", ")}`,
        `  Consensus : ${pot.consensus ? "✓ CONSENSUS" : "⚠ DEGRADED"}`,
        `  Deviation : ${pot.deviation_ms}ms`,
        `  Agent     : ${pot.agent_id}`,
        consensusWarning,
      ]
        .filter((l) => l !== "")
        .join("\n");

      if (callback) {
        await callback({
          text: responseText,
          content: { result },
        });
      }

      return { success: true, text: responseText, data: { result } };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error verifying PoT";
      if (callback) {
        await callback({
          text: `Failed to verify Proof-of-Time: ${errorMsg}`,
          content: { error: errorMsg },
        });
      }
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Verify the proof of time for my last transaction" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Proof-of-Time verification PASSED.\n\nToken Summary:\n  Issued    : 2026-03-17T07:00:00.000Z\n  Age       : 12s\n  Sources   : NIST, Apple, Google, Cloudflare\n  Consensus : ✓ CONSENSUS\n  Deviation : 120ms",
          actions: ["VERIFY_POT"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Check if the time attestation on this trade is valid" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Proof-of-Time verification PASSED.",
          actions: ["VERIFY_POT"],
        },
      },
    ],
  ] as ActionExample[][],
};
