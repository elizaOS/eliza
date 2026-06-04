import { describe, expect, it } from "vitest";
import {
  buildGoalPrompt,
  coerceGoalCapabilityProfile,
  DEFAULT_GOAL_CAPABILITIES,
  ECONOMICS_GOAL_CAPABILITIES,
  resolveGoalCapabilities,
} from "../services/goal-prompt.js";

describe("resolveGoalCapabilities", () => {
  it("defaults to the coding-only fence", () => {
    expect(resolveGoalCapabilities()).toBe(DEFAULT_GOAL_CAPABILITIES);
    expect(resolveGoalCapabilities("default")).toBe(DEFAULT_GOAL_CAPABILITIES);
  });

  it("returns the economics fence for the economics profile", () => {
    expect(resolveGoalCapabilities("economics")).toBe(
      ECONOMICS_GOAL_CAPABILITIES,
    );
  });
});

describe("coerceGoalCapabilityProfile", () => {
  it("recognizes known profiles case-insensitively", () => {
    expect(coerceGoalCapabilityProfile("economics")).toBe("economics");
    expect(coerceGoalCapabilityProfile(" Economics ")).toBe("economics");
    expect(coerceGoalCapabilityProfile("default")).toBe("default");
  });

  it("returns undefined for unknown / non-string values", () => {
    expect(coerceGoalCapabilityProfile("nope")).toBeUndefined();
    expect(coerceGoalCapabilityProfile(123)).toBeUndefined();
    expect(coerceGoalCapabilityProfile(undefined)).toBeUndefined();
  });
});

describe("buildGoalPrompt capability fence", () => {
  const baseInput = { agentName: "Ada", goal: "ship the thing" };

  it("keeps the coding-only fence by default", () => {
    const prompt = buildGoalPrompt(baseInput);
    expect(prompt).toContain("Use only coding-relevant capabilities");
    expect(prompt).toContain("edit/apply patches");
    expect(prompt).not.toContain("parent-agent Cloud command bridge");
  });

  it("renders the economics fence under the economics profile", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      capabilityProfile: "economics",
    });
    expect(prompt).toContain("authorized to use these capabilities");
    expect(prompt).toContain("parent-agent Cloud command bridge");
    expect(prompt).toContain("domains.buy");
    expect(prompt).not.toContain("Use only coding-relevant capabilities");
  });

  it("lets an explicit allow-list override the profile", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      capabilityProfile: "economics",
      allowedCapabilities: ["read/search files"],
    });
    expect(prompt).toContain("read/search files");
    expect(prompt).not.toContain("domains.buy");
  });
});
