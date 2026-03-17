import { randomBytes } from "crypto";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getVerifiedTime } from "../providers/timeProvider.js";

// Module-level cache: runtime has no cacheManager in this version of @elizaos/core
const MAX_CACHE_SIZE = 1000;
const potCache = new Map<string, { value: string; expiresAt: number }>();

// Periodic cleanup: evict expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of potCache.entries()) {
    if (now > entry.expiresAt) potCache.delete(key);
  }
}, 60_000);

export function potCacheSet(key: string, value: string, ttlSeconds: number): void {
  // Enforce size cap: evict oldest entry if at limit
  if (potCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = potCache.keys().next().value;
    if (oldestKey !== undefined) potCache.delete(oldestKey);
  }
  potCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function potCacheGet(key: string): string | null {
  const entry = potCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    potCache.delete(key);
    return null;
  }
  return entry.value;
}

export interface PoTToken {
  version: string;
  timestamp: number;
  sources: string[];
  consensus: boolean;
  deviation_ms: number;
  agent_id: string;
  nonce: string;
  potHash: string;
  issued_at: string;
}

/**
 * Generates a cryptographically-anchored Proof-of-Time token
 * using 4-source verified time (NIST, Apple, Google, Cloudflare).
 * Call this BEFORE submitting a trade or agent transaction.
 */
export const generatePot: Action = {
  name: "GENERATE_POT",
  similes: [
    "CREATE_PROOF_OF_TIME",
    "MINT_POT",
    "TIMESTAMP_TRANSACTION",
    "ATTEST_TIME",
    "GET_TIME_PROOF",
  ],
  description:
    "Generates a Proof-of-Time (PoT) token using multi-source verified time " +
    "(NIST, Apple, Google, Cloudflare). Use before submitting any trade or " +
    "agent transaction to create a tamper-evident temporal attestation.",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Always valid — time is always available (falls back to local if sources fail)
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult | void | undefined> => {
    try {
      const vt = await getVerifiedTime();

      // Generate a cryptographically secure nonce (Issue 3 fix)
      const agentId = runtime.agentId ?? "unknown";
      const nonce = randomBytes(16).toString("hex");

      // Compute a stable potHash for cache keying (Issue 1 fix)
      const potHashRaw = `${agentId}:${vt.timestamp}:${nonce}`;
      const potHash = Buffer.from(potHashRaw).toString("hex").slice(0, 48);

      const pot: PoTToken = {
        version: "1.0",
        timestamp: vt.timestamp,
        sources: vt.sources,
        consensus: vt.consensus,
        deviation_ms: vt.deviation_ms,
        agent_id: agentId,
        nonce,
        potHash,
        issued_at: new Date(vt.timestamp).toISOString(),
      };

      // Store PoT keyed by potHash (stable, survives message.id mismatch)
      potCacheSet(`openttt:pot:${pot.potHash}`, JSON.stringify(pot), 300);
      // Also store "last generated" pointer so verifyPot can find it without potHash
      potCacheSet(`openttt:last:${agentId}`, pot.potHash, 300);

      const consensusLabel = pot.consensus ? "✓ CONSENSUS" : "⚠ DEGRADED";
      const responseText = [
        `Proof-of-Time generated successfully.`,
        ``,
        `Token Details:`,
        `  Timestamp : ${pot.issued_at}`,
        `  Sources   : ${pot.sources.join(", ")}`,
        `  Consensus : ${consensusLabel}`,
        `  Deviation : ${pot.deviation_ms}ms`,
        `  Nonce     : ${pot.nonce}`,
        ``,
        `This PoT token is valid for 5 minutes. ` +
          `Attach it to your transaction before submitting.`,
      ].join("\n");

      if (callback) {
        await callback({
          text: responseText,
          content: { pot },
        });
      }

      return { success: true, text: responseText, data: { pot } };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error generating PoT";
      if (callback) {
        await callback({
          text: `Failed to generate Proof-of-Time: ${errorMsg}`,
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
        content: { text: "Generate a proof of time before I submit this trade" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Proof-of-Time generated successfully.\n\nToken Details:\n  Timestamp : 2026-03-17T07:00:00.000Z\n  Sources   : NIST, Apple, Google, Cloudflare\n  Consensus : ✓ CONSENSUS\n  Deviation : 120ms\n  Nonce     : 6f70656e7474740a...",
          actions: ["GENERATE_POT"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Timestamp this transaction with verified time" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Proof-of-Time generated successfully.",
          actions: ["GENERATE_POT"],
        },
      },
    ],
  ] as ActionExample[][],
};
