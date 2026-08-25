import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

type Ctx = {
  config: unknown;
  env: Record<string, unknown>;
};

const ctx = (config: unknown, env: Record<string, unknown> = {}): Ctx =>
  ({ config, env }) as Ctx;

describe("plugin-vision auto-enable gate", () => {
  it("enables when features.vision is true", () => {
    expect(shouldEnable(ctx({ features: { vision: true } }))).toBe(true);
  });

  it("enables when features.vision is an object that is not explicitly disabled", () => {
    expect(shouldEnable(ctx({ features: { vision: {} } }))).toBe(true);
    expect(shouldEnable(ctx({ features: { vision: { enabled: true } } }))).toBe(
      true,
    );
  });

  it("disables when features.vision.enabled is false", () => {
    expect(
      shouldEnable(ctx({ features: { vision: { enabled: false } } })),
    ).toBe(false);
  });

  it("enables when a concrete vision provider is configured", () => {
    expect(
      shouldEnable(ctx({ media: { vision: { provider: "openai" } } })),
    ).toBe(true);
    expect(
      shouldEnable(ctx({ media: { vision: { provider: "gemini" } } })),
    ).toBe(true);
  });

  it("rejects whitespace-only provider values (fail-open regression)", () => {
    expect(shouldEnable(ctx({ media: { vision: { provider: " " } } }))).toBe(
      false,
    );
    expect(shouldEnable(ctx({ media: { vision: { provider: "   " } } }))).toBe(
      false,
    );
    expect(shouldEnable(ctx({ media: { vision: { provider: "\t" } } }))).toBe(
      false,
    );
  });

  it("rejects empty provider values", () => {
    expect(shouldEnable(ctx({ media: { vision: { provider: "" } } }))).toBe(
      false,
    );
  });

  it("keeps whitespace-padded but concrete provider values enabled", () => {
    expect(
      shouldEnable(ctx({ media: { vision: { provider: " openai " } } })),
    ).toBe(true);
  });

  it("honors explicit media.vision.enabled=false even with a provider", () => {
    expect(
      shouldEnable(
        ctx({ media: { vision: { enabled: false, provider: "openai" } } }),
      ),
    ).toBe(false);
  });

  it("rejects non-string provider values", () => {
    expect(shouldEnable(ctx({ media: { vision: { provider: 42 } } }))).toBe(
      false,
    );
    expect(shouldEnable(ctx({ media: { vision: { provider: null } } }))).toBe(
      false,
    );
  });

  it("rejects array-valued feature flags (fail-open regression)", () => {
    expect(shouldEnable(ctx({ features: { vision: [] } }))).toBe(false);
    expect(shouldEnable(ctx({ features: { vision: ["x"] } }))).toBe(false);
  });

  it("disables when nothing is configured", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ features: {} }))).toBe(false);
  });
});
