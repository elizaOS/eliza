/**
 * Pins identity-link proof generation to an unbiased bounded CSPRNG draw for
 * every character, including rejection of an out-of-range generator result.
 */
import { describe, expect, it, vi } from "vitest";
import { LINK_CODE_PATTERN, mintIdentityLinkCode } from "./identity-link-code";

describe("mintIdentityLinkCode", () => {
  it("draws every symbol from the full alphabet without modulo reduction", () => {
    const indices = [0, 30, 0, 30, 0, 30, 0, 30];
    const randomIndex = vi.fn((maxExclusive: number) => {
      expect(maxExclusive).toBe(31);
      return indices.shift() ?? 0;
    });

    const code = mintIdentityLinkCode(randomIndex);

    expect(code).toBe("A9A9A9A9");
    expect(`LINK-${code}`).toMatch(LINK_CODE_PATTERN);
    expect(randomIndex).toHaveBeenCalledTimes(8);
  });

  it("rejects a random index outside the bounded alphabet", () => {
    expect(() => mintIdentityLinkCode(() => 31)).toThrow("outside the code alphabet");
  });
});
