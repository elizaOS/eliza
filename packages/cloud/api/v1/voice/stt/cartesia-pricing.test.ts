import { expect, test } from "bun:test";
import {
  CARTESIA_PUBLISHED_USD_PER_CREDIT,
  parseCartesiaUsdPerCredit,
} from "./cartesia-pricing";

test("an unset account rate uses the published upper bound", () => {
  expect(CARTESIA_PUBLISHED_USD_PER_CREDIT).toBe(0.000065);
  expect(parseCartesiaUsdPerCredit(undefined)).toBe(0.000065);
  expect(parseCartesiaUsdPerCredit("  ")).toBe(0.000065);
});

test("a configured account rate wins and a malformed one fails closed", () => {
  expect(parseCartesiaUsdPerCredit("0.000038")).toBe(0.000038);
  for (const value of ["0", "-1", "abc", "Infinity"])
    expect(() => parseCartesiaUsdPerCredit(value)).toThrow(
      "CARTESIA_STT_USD_PER_CREDIT must be a positive finite number",
    );
});
