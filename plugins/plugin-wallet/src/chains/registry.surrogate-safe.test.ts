/**
 * Unit tests for surrogate-safe truncation in PumpPortal trade error reporting.
 *
 * Tests that error details truncated across UTF-16 surrogate boundaries
 * remain well-formed without lone surrogates or encoding errors when
 * fetchPumpFunTransaction fails.
 */

import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPumpFunTransaction } from "./registry";

describe("wallet registry surrogate-safe error truncation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves well-formed error message when error detail splits across surrogate pair", async () => {
    // 239 standard characters followed by a 2-code-unit emoji (surrogate pair)
    const base = "A".repeat(239);
    const emoji = "🚀"; // \uD83D\uDE80
    const errorBody = `${base}${emoji}extra error details`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(errorBody, {
          status: 400,
          statusText: "Bad Request",
        }),
      ),
    );

    const pubkey = new PublicKey("11111111111111111111111111111111");
    const settings = {
      tradeLocalUrl: "https://pumpportal.fun/api/trade-local",
      slippage: 1,
      priorityFee: 0.001,
      pool: "pump" as const,
    };

    let caughtError: Error | null = null;
    try {
      await fetchPumpFunTransaction(pubkey, "mint123", 1, settings);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain(
      "PumpPortal trade-local failed (400)",
    );
    // The truncated detail should not contain a lone high surrogate
    expect(caughtError?.message.endsWith("\uD83D")).toBe(false);
    expect(caughtError?.message.isWellFormed?.() ?? true).toBe(true);
  });
});
