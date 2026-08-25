import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

type Ctx = {
  config: unknown;
  env: Record<string, unknown>;
};

const ctx = (config: unknown, env: Record<string, unknown> = {}): Ctx =>
  ({ config, env }) as Ctx;

describe("plugin-browser auto-enable gate", () => {
  it("enables when features.browser is true", () => {
    expect(shouldEnable(ctx({ features: { browser: true } }))).toBe(true);
  });

  it("enables when features.browser is an object that is not explicitly disabled", () => {
    expect(shouldEnable(ctx({ features: { browser: {} } }))).toBe(true);
    expect(
      shouldEnable(ctx({ features: { browser: { enabled: true } } })),
    ).toBe(true);
  });

  it("disables when features.browser.enabled is false", () => {
    expect(
      shouldEnable(ctx({ features: { browser: { enabled: false } } })),
    ).toBe(false);
  });

  it("rejects array-valued feature configs (fail-open regression)", () => {
    expect(shouldEnable(ctx({ features: { browser: [] } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { browser: ["x"] } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { browser: [1, 2] } }))).toBe(false);
  });

  it("disables when the feature flag is absent", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ features: {} }))).toBe(false);
    expect(shouldEnable(ctx({ features: { other: true } }))).toBe(false);
  });

  it("disables on null or scalar feature values", () => {
    expect(shouldEnable(ctx({ features: { browser: null } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { browser: "yes" } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { browser: 0 } }))).toBe(false);
  });
});
