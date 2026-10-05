import { expect, it } from "vitest";
import { getProvidedApiToken, tokenMatches } from "./tokens";

it("compares the complete bearer token without silently truncating it", () => {
  const token = "a".repeat(1200);
  expect(
    getProvidedApiToken({ headers: { authorization: `Bearer ${token}` } }),
  ).toBe(token);
  expect(tokenMatches(token, `${token}x`)).toBe(false);
  expect(tokenMatches(token, token)).toBe(true);
});
