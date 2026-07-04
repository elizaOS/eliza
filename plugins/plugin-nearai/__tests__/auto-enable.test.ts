/** Unit tests for `shouldEnable` — asserts auto-enable keys on a non-empty NEARAI_API_KEY. */
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

function ctx(env: Record<string, string | undefined>) {
  return { env };
}

describe("NEAR AI auto-enable", () => {
  it("enables on NEARAI_API_KEY", () => {
    expect(shouldEnable(ctx({ NEARAI_API_KEY: "key" }))).toBe(true);
  });

  it("does not enable without a non-empty key", () => {
    expect(shouldEnable(ctx({ NEARAI_API_KEY: " " }))).toBe(false);
  });
});
