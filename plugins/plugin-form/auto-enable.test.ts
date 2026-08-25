import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

type Ctx = {
  config: unknown;
  env: Record<string, unknown>;
};

const ctx = (config: unknown, env: Record<string, unknown> = {}): Ctx =>
  ({ config, env }) as Ctx;

describe("plugin-form auto-enable gate", () => {
  it("enables when features.form is true", () => {
    expect(shouldEnable(ctx({ features: { form: true } }))).toBe(true);
  });

  it("enables when features.form is an object that is not explicitly disabled", () => {
    expect(shouldEnable(ctx({ features: { form: {} } }))).toBe(true);
    expect(shouldEnable(ctx({ features: { form: { enabled: true } } }))).toBe(
      true,
    );
  });

  it("disables when features.form.enabled is false", () => {
    expect(shouldEnable(ctx({ features: { form: { enabled: false } } }))).toBe(
      false,
    );
  });

  it("rejects array-valued feature configs (fail-open regression)", () => {
    expect(shouldEnable(ctx({ features: { form: [] } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { form: ["x"] } }))).toBe(false);
  });

  it("disables when the feature flag is absent", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ features: {} }))).toBe(false);
  });

  it("disables on null or scalar feature values", () => {
    expect(shouldEnable(ctx({ features: { form: null } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { form: "yes" } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { form: 0 } }))).toBe(false);
  });
});
