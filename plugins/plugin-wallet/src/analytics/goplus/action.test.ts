/**
 * Drives the WALLET `token_safety` handler with a recorded GoPlus Solana
 * payload through an injected fetch, and the real `walletRouterAction`
 * dispatch for inputs that resolve before any network call. Deterministic and
 * keyless; covers mint resolution from params and text, the complete
 * planner-facing report, chain and ambiguity rejection, and upstream failure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import type { WalletTerminalTokenSafetyResponse } from "../../contracts";
import { resolveTokenSafetyMint, tokenSafetyHandler } from "./action";
import type { GoPlusFetch } from "./solana-token-security";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../routes/__fixtures__/goplus-solana-token-security.recorded.json",
    ),
    "utf8",
  ),
) as { mint: string; goplus: unknown };
const MINT = recorded.mint;
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const runtime = {} as IAgentRuntime;

const msg = (text: string): Memory =>
  ({ content: { text } }) as unknown as Memory;

function recordingFetch(response: Response): {
  fetcher: GoPlusFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (input) => {
      calls.push(String(input));
      return response;
    },
  };
}

const ok = () =>
  new Response(JSON.stringify(recorded.goplus), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("resolveTokenSafetyMint", () => {
  it("prefers a valid mint param, then a single address in the text", () => {
    expect(resolveTokenSafetyMint(msg("check it"), { address: MINT })).toEqual({
      mint: MINT,
    });
    expect(
      resolveTokenSafetyMint(msg(`is ${MINT} a rug?`), {
        parameters: { address: "BONK" },
      }),
    ).toEqual({ mint: MINT });
  });

  it("refuses to guess between two addresses or with none", () => {
    expect(resolveTokenSafetyMint(msg(`${MINT} or ${OTHER_MINT}?`))).toEqual({
      error: "AMBIGUOUS_MINT",
    });
    expect(resolveTokenSafetyMint(msg("is bonk safe?"))).toEqual({
      error: "MISSING_MINT",
    });
  });
});

describe("tokenSafetyHandler", () => {
  it("returns the complete report as planner text and structured data", async () => {
    const { fetcher, calls } = recordingFetch(ok());
    const emitted: string[] = [];
    const result = await tokenSafetyHandler(
      runtime,
      msg(`Crypto Queen, is ${MINT} safe to ape?`),
      undefined,
      undefined,
      async (content) => {
        emitted.push(String(content.text));
        return [];
      },
      fetcher,
    );
    expect(result.success).toBe(true);
    expect(calls[0]).toContain(`contract_addresses=${MINT}`);
    const report = (
      result.data as { report: WalletTerminalTokenSafetyResponse }
    ).report;
    expect(report.verdict).toBe("caution");
    // Every check reaches the model; none is dropped to fit.
    for (const entry of report.checks) {
      expect(result.text).toContain(`- ${entry.label}: `);
    }
    expect(result.text).toContain("CAUTION");
    expect(result.text).toContain("Bonk (Bonk)");
    expect(result.text).toMatch(/Top 10 holders own 38\.4%/);
    expect(emitted).toEqual([result.text]);
  });

  it("rejects non-Solana chains and missing mints without a request", async () => {
    const { fetcher, calls } = recordingFetch(ok());
    const evm = await tokenSafetyHandler(
      runtime,
      msg("check 0xabc"),
      undefined,
      { chain: "base", address: MINT },
      undefined,
      fetcher,
    );
    expect(evm).toMatchObject({ success: false, error: "UNSUPPORTED_CHAIN" });
    const missing = await tokenSafetyHandler(
      runtime,
      msg("is it safe?"),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(missing).toMatchObject({ success: false, error: "MISSING_MINT" });
    expect(calls).toHaveLength(0);
  });

  it("reports an upstream failure instead of a verdict", async () => {
    const { fetcher } = recordingFetch(new Response("{}", { status: 503 }));
    const result = await tokenSafetyHandler(
      runtime,
      msg(MINT),
      undefined,
      undefined,
      undefined,
      fetcher,
    );
    expect(result).toMatchObject({
      success: false,
      error: "TOKEN_SAFETY_UNAVAILABLE",
    });
    expect(result.text).toContain("GoPlus responded 503");
  });
});

describe("WALLET action=token_safety", () => {
  it("routes to the token safety handler, not the financial gate", async () => {
    const result = await walletRouterAction.handler(
      runtime,
      msg("is it safe?"),
      undefined,
      { parameters: { action: "token_safety" } },
    );
    expect(result).toMatchObject({
      success: false,
      error: "MISSING_MINT",
      data: { actionName: "WALLET", subaction: "token_safety" },
    });
  });
});
