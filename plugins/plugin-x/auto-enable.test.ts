import { describe, expect, it } from "vitest";
import { shouldEnable } from "./x-auto-enable";

function ctx(config: Record<string, unknown>): {
  env: Record<string, string | undefined>;
  config: Record<string, unknown>;
  isNativePlatform: boolean;
} {
  return { env: {}, config, isNativePlatform: false };
}

describe("plugin-x auto-enable", () => {
  it("enables when connectors.x is present and not disabled", () => {
    expect(
      shouldEnable(ctx({ connectors: { x: { apiKey: "k", apiSecret: "s" } } })),
    ).toBe(true);
  });

  it("enables via the legacy connectors.twitter alias", () => {
    expect(
      shouldEnable(ctx({ connectors: { twitter: { apiKey: "k" } } })),
    ).toBe(true);
  });

  it("does NOT enable when the connector block is explicitly disabled", () => {
    expect(
      shouldEnable(ctx({ connectors: { x: { enabled: false, apiKey: "k" } } })),
    ).toBe(false);
    expect(
      shouldEnable(ctx({ connectors: { twitter: { enabled: false } } })),
    ).toBe(false);
  });

  it("does NOT enable without a connectors block", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
  });

  it("skips non-object connector entries", () => {
    expect(shouldEnable(ctx({ connectors: { x: "not-an-object" } }))).toBe(
      false,
    );
  });
});
