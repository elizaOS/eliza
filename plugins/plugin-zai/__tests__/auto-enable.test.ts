import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

function ctx(env: Record<string, string | undefined>) {
  return { env };
}

describe("z.ai auto-enable", () => {
  it("enables on ZAI_API_KEY", () => {
    expect(shouldEnable(ctx({ ZAI_API_KEY: "key" }))).toBe(true);
  });

  it("enables on legacy Z_AI_API_KEY", () => {
    expect(shouldEnable(ctx({ Z_AI_API_KEY: "key" }))).toBe(true);
  });

  it("does not enable without a non-empty key", () => {
    expect(shouldEnable(ctx({ ZAI_API_KEY: " ", Z_AI_API_KEY: "" }))).toBe(false);
  });
});
