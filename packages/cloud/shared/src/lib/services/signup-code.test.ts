/**
 * Strict parsing coverage for SIGNUP_CODES_JSON bonus values (#20132):
 * parseFloat accepted numeric prefixes ("25credits" -> 25) and returned
 * Infinity for "Infinity", which passed the isNaN-only guard. The defensive
 * string branch must accept only complete canonical positive decimals, and
 * non-finite shapes must never reach the codes map.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// The module pulls service/repository dependencies that are irrelevant to
// parsing; mock them so the import chain stays offline and deterministic.
mock.module("../../db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: {
    hasSignupCodeBonus: async () => false,
    recordTransaction: async () => ({}),
  },
}));
mock.module("./credits", () => ({
  creditsService: { addCredits: async () => ({}) },
}));
mock.module("../utils/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const { getBonusForCode, resetSignupCodesCacheForTests } = await import(
  "./signup-code.ts"
);

function setEnvCodes(entries: Record<string, unknown>): void {
  process.env.SIGNUP_CODES_JSON = JSON.stringify({ codes: entries });
  resetSignupCodesCacheForTests();
}

beforeEach(() => {
  resetSignupCodesCacheForTests();
});

describe("SIGNUP_CODES_JSON strict bonus parsing (#20132)", () => {
  test("prefix-garbage and non-canonical string values are rejected", () => {
    setEnvCodes({
      prefix: "25credits",
      exponent: "1e2",
      hex: "0x10",
      signed: "+25",
      leadingdot: ".5",
      trailingdot: "25.",
      infinity: "Infinity",
      nanword: "NaN",
      negative: "-25",
      zero: "0",
      empty: "",
    });
    for (const code of [
      "prefix",
      "exponent",
      "hex",
      "signed",
      "leadingdot",
      "trailingdot",
      "infinity",
      "nanword",
      "negative",
      "zero",
      "empty",
    ]) {
      expect(getBonusForCode(code)).toBeUndefined();
    }
  });

  test("canonical integer and decimal string values are accepted", () => {
    setEnvCodes({ welcome: "25", launch: "12.50", big: "1000", padded: " 7.5 " });
    expect(getBonusForCode("WELCOME")).toBe(25);
    expect(getBonusForCode("launch")).toBe(12.5);
    expect(getBonusForCode("BIG")).toBe(1000);
    expect(getBonusForCode("padded")).toBe(7.5);
  });

  test("non-finite numeric values are rejected even on the number branch", () => {
    // JSON.parse cannot produce Infinity, but the defensive guard must not
    // rely on that: the map never carries a non-finite grant.
    setEnvCodes({ inf: Number.POSITIVE_INFINITY, nan: Number.NaN, neg: -5, ok: 30 });
    expect(getBonusForCode("inf")).toBeUndefined();
    expect(getBonusForCode("nan")).toBeUndefined();
    expect(getBonusForCode("neg")).toBeUndefined();
    expect(getBonusForCode("ok")).toBe(30);
  });

  test("codes are matched case- and whitespace-insensitively", () => {
    setEnvCodes({ launch: "25" });
    expect(getBonusForCode("  LAUNCH  ")).toBe(25);
  });
});
