/**
 * Verifies resolveGoalCapabilities.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
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

  it("adds the ViewKind contract for economics app/view goals (#8917)", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      capabilityProfile: "economics",
    });

    expect(prompt).toContain("--- ViewKind Contract ---");
    expect(prompt).toContain("`release` is the default");
    expect(prompt).toContain("`preview` is for unfinished");
    expect(prompt).toContain("`developer` is for dev tooling");
    expect(prompt).toContain("`system` is reserved");
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

describe("buildGoalPrompt attempt reflections (#8899)", () => {
  const baseInput = { agentName: "Ada", goal: "ship the thing" };

  it("omits the Past Attempt Failures section when there are no reflections", () => {
    expect(buildGoalPrompt(baseInput)).not.toContain("Past Attempt Failures");
    expect(
      buildGoalPrompt({ ...baseInput, attemptReflections: [] }),
    ).not.toContain("Past Attempt Failures");
  });

  it("replays prior failed attempts (summary + missing) on re-spawn", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      attemptReflections: [
        {
          attempt: 1,
          summary: "tests were never run",
          missing: ["unit tests pass", "typecheck clean"],
        },
        { attempt: 2, summary: "lint still failing", missing: [] },
      ],
    });
    expect(prompt).toContain("--- Past Attempt Failures ---");
    expect(prompt).toContain("Do NOT repeat these mistakes");
    expect(prompt).toContain("Attempt 1: tests were never run");
    expect(prompt).toContain("Missing: unit tests pass; typecheck clean.");
    expect(prompt).toContain("Attempt 2: lint still failing");
    // No "Missing:" suffix when the attempt listed nothing missing.
    expect(prompt).not.toContain("Attempt 2: lint still failing. Missing:");
  });
});
