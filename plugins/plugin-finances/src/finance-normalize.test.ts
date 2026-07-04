/**
 * Unit tests for the finances input-normalization helpers (`fail`,
 * `requireAgentId`, `requireNonEmptyString`, the optional string/boolean
 * coercions) and the `FinancesServiceError` HTTP-status carrier. Pure functions,
 * no runtime or DB.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  FinancesServiceError,
  fail,
  financeErrorMessage,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireAgentId,
  requireNonEmptyString,
} from "./finance-normalize.js";

const rt = (agentId: unknown): IAgentRuntime =>
  ({ agentId }) as unknown as IAgentRuntime;

function expectFail(fn: () => unknown, status: number): FinancesServiceError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FinancesServiceError);
    expect((e as FinancesServiceError).status).toBe(status);
    return e as FinancesServiceError;
  }
  throw new Error("expected a FinancesServiceError");
}

describe("finance-normalize shared validators", () => {
  it("fail carries status + code; financeErrorMessage unwraps", () => {
    const err = expectFail(() => fail(402, "pay", "PAYMENT"), 402);
    expect(err.message).toBe("pay");
    expect(err.code).toBe("PAYMENT");
    expect(financeErrorMessage(new Error("x"))).toBe("x");
    expect(financeErrorMessage(9)).toBe("9");
  });

  it("requireAgentId / requireNonEmptyString / normalizeOptionalString", () => {
    expect(requireAgentId(rt("a"))).toBe("a");
    expectFail(() => requireAgentId(rt("")), 500);
    expect(requireNonEmptyString(" hi ", "f")).toBe("hi");
    expectFail(() => requireNonEmptyString(1, "f"), 400);
    expect(normalizeOptionalString("  v ")).toBe("v");
    expect(normalizeOptionalString("")).toBeUndefined();
  });
});

describe("normalizeOptionalBoolean", () => {
  it("passes undefined through and accepts real booleans", () => {
    expect(normalizeOptionalBoolean(undefined, "f")).toBeUndefined();
    expect(normalizeOptionalBoolean(true, "f")).toBe(true);
    expect(normalizeOptionalBoolean(false, "f")).toBe(false);
  });

  it("coerces the documented string forms", () => {
    expect(normalizeOptionalBoolean("true", "f")).toBe(true);
    expect(normalizeOptionalBoolean("1", "f")).toBe(true);
    expect(normalizeOptionalBoolean("FALSE", "f")).toBe(false);
    expect(normalizeOptionalBoolean("0", "f")).toBe(false);
    expect(normalizeOptionalBoolean(" True ", "f")).toBe(true);
  });

  it("rejects ambiguous values (400)", () => {
    expectFail(() => normalizeOptionalBoolean("yes", "f"), 400);
    expectFail(() => normalizeOptionalBoolean(2, "f"), 400);
    expectFail(() => normalizeOptionalBoolean(null, "f"), 400);
  });
});
