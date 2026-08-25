import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

type Ctx = {
  config: {
    features?: Record<string, unknown>;
  };
  env?: Record<string, string | undefined>;
};

function ctx(features: Record<string, unknown> | undefined): Ctx {
  return { config: { features } };
}

describe("plugin-agent-skills auto-enable gate", () => {
  it("enables when the agentSkills feature flag is boolean true", () => {
    expect(shouldEnable(ctx({ agentSkills: true }) as never)).toBe(true);
  });

  it("enables when the agentSkills feature is an object with enabled: true", () => {
    expect(shouldEnable(ctx({ agentSkills: { enabled: true } }) as never)).toBe(
      true,
    );
  });

  it("enables when the agentSkills feature is an object without explicit disable", () => {
    expect(shouldEnable(ctx({ agentSkills: {} }) as never)).toBe(true);
  });

  it("disables when the agentSkills feature is explicitly disabled", () => {
    expect(shouldEnable(ctx({ agentSkills: { enabled: false } }) as never)).toBe(
      false,
    );
  });

  it("disables when the agentSkills feature is missing", () => {
    expect(shouldEnable(ctx({}) as never)).toBe(false);
    expect(shouldEnable(ctx(undefined) as never)).toBe(false);
  });

  it("disables when the agentSkills feature is a non-object truthy value", () => {
    expect(shouldEnable(ctx({ agentSkills: "yes" }) as never)).toBe(false);
  });

  it("rejects array-valued feature configs instead of treating them as enabled objects", () => {
    // `[]` passes `typeof [] === "object"` and `[].enabled !== false`, which
    // would silently enable the plugin for a malformed/empty list value.
    expect(shouldEnable(ctx({ agentSkills: [] }) as never)).toBe(false);
    expect(shouldEnable(ctx({ agentSkills: ["a", "b"] }) as never)).toBe(false);
  });
});
