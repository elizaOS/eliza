/**
 * Exercises the fail-closed NUMERIC boundary for the MCP `withCredits()` balance
 * pre-check (#13415) and pins the money-out fail-open regression it closes: a
 * corrupt `'NaN'::numeric` credit_balance must DENY a paid tool call, never let
 * it run free.
 */
import { describe, expect, mock, test } from "bun:test";
import type { MCPToolContext } from "./helpers";
import { withCredits } from "./helpers";
import { CorruptMcpCreditBalanceError, parseMcpCreditBalance } from "./withcredits-numeric";

describe("parseMcpCreditBalance", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseMcpCreditBalance("10.5000")).toBe(10.5);
    expect(parseMcpCreditBalance("100")).toBe(100);
    expect(parseMcpCreditBalance("-5.25")).toBe(-5.25);
  });

  test("parses a numeric value", () => {
    expect(parseMcpCreditBalance(42)).toBe(42);
  });

  test("parses an explicit zero (legitimate domain value)", () => {
    expect(parseMcpCreditBalance("0")).toBe(0);
    expect(parseMcpCreditBalance("0.0000")).toBe(0);
    expect(parseMcpCreditBalance(0)).toBe(0);
  });

  test("throws on the 'NaN' string a corrupt Postgres NUMERIC reads back as", () => {
    // `'NaN'::numeric` is a valid Postgres NUMERIC and the driver returns "NaN".
    expect(() => parseMcpCreditBalance("NaN")).toThrow(CorruptMcpCreditBalanceError);
  });

  test("throws on null / undefined / empty / whitespace", () => {
    expect(() => parseMcpCreditBalance(null)).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance(undefined)).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance("")).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance("   ")).toThrow(CorruptMcpCreditBalanceError);
  });

  test("throws on JS-only coercions Number() would otherwise accept", () => {
    expect(() => parseMcpCreditBalance("1e3")).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance("0x10")).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance("Infinity")).toThrow(CorruptMcpCreditBalanceError);
    expect(() => parseMcpCreditBalance("12abc")).toThrow(CorruptMcpCreditBalanceError);
  });

  test("preserves the raw value on the thrown error for repair", () => {
    try {
      parseMcpCreditBalance("NaN");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptMcpCreditBalanceError);
      expect((err as CorruptMcpCreditBalanceError).rawValue).toBe("NaN");
      expect((err as CorruptMcpCreditBalanceError).code).toBe("CORRUPT_MCP_CREDIT_BALANCE");
      expect((err as CorruptMcpCreditBalanceError).context).toEqual({
        rawValue: "NaN",
        reason: "value is not a valid NUMERIC",
      });
      expect((err as CorruptMcpCreditBalanceError).severity).toBe("fatal");
    }
  });

  test("REGRESSION: the bare-Number gate the fix replaced fails OPEN on 'NaN'", () => {
    // Documents exactly why the old `Number(credit_balance) < toolCost` gate was
    // unsafe: NaN < toolCost is false, so the insufficient-credit gate is skipped.
    const toolCost = 5;
    expect(Number("NaN") < toolCost).toBe(false);
    // The fail-closed parser refuses the corrupt value instead.
    expect(() => parseMcpCreditBalance("NaN")).toThrow(CorruptMcpCreditBalanceError);
  });
});

/** Build a minimal MCPToolContext with a given org credit_balance. */
function makeContext(creditBalance: unknown) {
  const deductCredits = mock(async () => ({
    success: true,
    newBalance: 999,
    transactionId: "tx_test",
  }));
  const refundCredits = mock(async () => {});
  const context = {
    user: {} as MCPToolContext["user"],
    org: { credit_balance: creditBalance } as unknown as MCPToolContext["org"],
    getToolCache: async () => null,
    setToolCache: async () => {},
    invalidateToolCache: async () => {},
    deductCredits,
    refundCredits,
  } as unknown as MCPToolContext;
  return { context, deductCredits, refundCredits };
}

describe("withCredits balance pre-check (fail-closed money gate)", () => {
  test("runs the paid tool and deducts when balance is sufficient", async () => {
    const { context, deductCredits } = makeContext("100");
    const handler = mock(async () => "ok");
    const wrapped = withCredits("paid_tool", 5, {}, handler);

    await expect(wrapped({}, context)).resolves.toBe("ok");
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("denies (never deducts) when balance is genuinely insufficient", async () => {
    const { context, deductCredits } = makeContext("2");
    const handler = mock(async () => "ok");
    const wrapped = withCredits("paid_tool", 5, {}, handler);

    await expect(wrapped({}, context)).rejects.toThrow(/Insufficient credits/);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test("REGRESSION: corrupt 'NaN' balance DENIES the paid tool (was: ran free)", async () => {
    const { context, deductCredits, refundCredits } = makeContext("NaN");
    const handler = mock(async () => "ok");
    const wrapped = withCredits("paid_tool", 5, {}, handler);

    await expect(wrapped({}, context)).rejects.toThrow(CorruptMcpCreditBalanceError);
    // Critically: the fail-open path would have called deductCredits + handler.
    expect(deductCredits).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("corrupt empty balance DENIES the paid tool", async () => {
    const { context, deductCredits } = makeContext("");
    const handler = mock(async () => "ok");
    const wrapped = withCredits("paid_tool", 5, {}, handler);

    await expect(wrapped({}, context)).rejects.toThrow(CorruptMcpCreditBalanceError);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("explicit zero balance is read (not corrupt) and denies the paid tool", async () => {
    const { context, deductCredits } = makeContext("0");
    const handler = mock(async () => "ok");
    const wrapped = withCredits("paid_tool", 5, {}, handler);

    // Denied by the `< toolCost` comparison, not by the corruption boundary.
    await expect(wrapped({}, context)).rejects.toThrow(/Insufficient credits/);
    expect(deductCredits).not.toHaveBeenCalled();
  });
});
