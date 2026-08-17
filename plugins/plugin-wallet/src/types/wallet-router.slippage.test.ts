/**
 * Wallet-router `slippageBps` is swap-tolerance identity, leftover tax
 * after cloud list `limit` leftover-tax. Stock develop used
 * z.coerce.number(), which treated string `1e2` / `007` / `0x10` as a
 * slippage instead of a parse failure. support / dryRun / amount stay
 * untouched. Missing still means the chain default.
 */
import { describe, expect, it } from "vitest";
import { parseWalletRouterParams } from "./wallet-router.ts";

function parse(slippageBps?: unknown) {
  const input: Record<string, unknown> = { subaction: "swap" };
  if (arguments.length > 0) {
    input.slippageBps = slippageBps;
  }
  return parseWalletRouterParams(input);
}

describe("wallet-router slippageBps identity", () => {
  it("accepts omitted slippageBps as the chain-default tolerance", () => {
    const params = parse();
    expect(params.subaction).toBe("swap");
    expect(params.slippageBps).toBeUndefined();
  });

  it("accepts slippageBps=50 as an exact swap tolerance", () => {
    expect(parse(50).slippageBps).toBe(50);
  });

  it("accepts slippageBps=0 as a legal zero-slippage quote", () => {
    expect(parse(0).slippageBps).toBe(0);
    expect(parse("0").slippageBps).toBe(0);
  });

  it("accepts canonical string slippageBps=250", () => {
    expect(parse("250").slippageBps).toBe(250);
  });

  it("rejects a canonical oversize slippageBps before routing", () => {
    expect(() => parse(10001)).toThrow();
    expect(() => parse("10001")).toThrow();
  });

  it.each(["1e2", "12px", "007", "abc", "-1", "50abc", " 50", "50 ", "0x10"])(
    "rejects prefix-coerced slippageBps=%s before routing",
    (token) => {
      expect(() => parse(token)).toThrow();
    },
  );
});
