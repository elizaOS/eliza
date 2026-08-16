/**
 * Exercises signup-code configuration parsing and cached lookup with mocked
 * credit persistence dependencies.
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

const { getBonusForCode, parseSignupCodeBonus, resetSignupCodesCacheForTests } = await import(
  "./signup-code.ts"
);

function setEnvCodes(entries: Record<string, unknown>): void {
  process.env.SIGNUP_CODES_JSON = JSON.stringify({ codes: entries });
  resetSignupCodesCacheForTests();
}

beforeEach(() => {
  resetSignupCodesCacheForTests();
});

describe("SIGNUP_CODES_JSON strict bonus parsing", () => {
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
    expect(parseSignupCodeBonus(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseSignupCodeBonus(Number.NaN)).toBeNull();
    expect(parseSignupCodeBonus(-5)).toBeNull();
    expect(parseSignupCodeBonus(30)).toBe(30);
  });

  test("codes are matched case- and whitespace-insensitively", () => {
    setEnvCodes({ launch: "25" });
    expect(getBonusForCode("  LAUNCH  ")).toBe(25);
  });
});
