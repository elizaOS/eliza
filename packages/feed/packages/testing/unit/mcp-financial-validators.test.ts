import { describe, expect, it } from "bun:test";
import {
  validateBuySharesArgs,
  validateCreatePostArgs,
  validateOpenPositionArgs,
  validatePlaceBetArgs,
} from "../../mcp/src/utils/tool-args-validation";

/**
 * MCP tool-arg validators gate untrusted agent input into financial actions.
 * Amounts must be positive (no zero/negative bets), leverage is bounded 1..100
 * (no excessive leverage), enums constrain side/outcome, and post content is
 * length-bounded — a missing check here lets a malicious tool call through.
 */

describe("validatePlaceBetArgs", () => {
  it("accepts a valid bet, rejects bad side / non-positive amount", () => {
    expect(
      validatePlaceBetArgs({ marketId: "m1", side: "YES", amount: 10 }),
    ).toEqual({ marketId: "m1", side: "YES", amount: 10 });
    expect(() =>
      validatePlaceBetArgs({ marketId: "m1", side: "MAYBE", amount: 10 }),
    ).toThrow();
    expect(() =>
      validatePlaceBetArgs({ marketId: "m1", side: "YES", amount: -5 }),
    ).toThrow();
    expect(() =>
      validatePlaceBetArgs({ marketId: "", side: "YES", amount: 10 }),
    ).toThrow();
  });
});

describe("validateBuySharesArgs", () => {
  it("requires marketId, YES/NO outcome, positive amount", () => {
    expect(
      validateBuySharesArgs({ marketId: "m1", outcome: "NO", amount: 3 }),
    ).toMatchObject({ outcome: "NO" });
    expect(() =>
      validateBuySharesArgs({ marketId: "m1", outcome: "NO", amount: 0 }),
    ).toThrow();
  });
});

describe("validateOpenPositionArgs", () => {
  it("bounds leverage to 1..100 and requires LONG/SHORT", () => {
    expect(
      validateOpenPositionArgs({
        ticker: "ABC",
        side: "LONG",
        amount: 100,
        leverage: 10,
      }),
    ).toMatchObject({ leverage: 10 });
    expect(() =>
      validateOpenPositionArgs({
        ticker: "ABC",
        side: "LONG",
        amount: 100,
        leverage: 500, // excessive leverage
      }),
    ).toThrow();
    expect(() =>
      validateOpenPositionArgs({
        ticker: "ABC",
        side: "SIDEWAYS",
        amount: 100,
        leverage: 10,
      }),
    ).toThrow();
  });
});

describe("validateCreatePostArgs", () => {
  it("bounds content length and validates media URL", () => {
    expect(validateCreatePostArgs({ content: "hello" }).type).toBe("post");
    expect(() => validateCreatePostArgs({ content: "" })).toThrow();
    expect(() =>
      validateCreatePostArgs({ content: "x".repeat(5001) }),
    ).toThrow();
    expect(() =>
      validateCreatePostArgs({ content: "ok", mediaUrl: "not-a-url" }),
    ).toThrow();
  });
});
