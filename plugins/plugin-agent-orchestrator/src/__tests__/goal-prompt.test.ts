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

  it("omits the broker capability on the default fence when not wired", () => {
    const prompt = buildGoalPrompt(baseInput);
    expect(prompt).not.toContain("parent-agent bridge");
  });

  it("advertises the broker on the default fence only when wired", () => {
    const prompt = buildGoalPrompt({ ...baseInput, brokerWired: true });
    expect(prompt).toContain("Use only coding-relevant capabilities");
    expect(prompt).toContain("parent-agent bridge");
    expect(prompt).toContain("paid/mutating commands stay gated");
  });

  it("does not double-advertise the broker on the economics fence", () => {
    // Economics already lists the full Cloud command surface; brokerWired must
    // not append the default-fence broker line on top of it.
    const prompt = buildGoalPrompt({
      ...baseInput,
      capabilityProfile: "economics",
      brokerWired: true,
    });
    expect(prompt).toContain("parent-agent Cloud command bridge");
    expect(prompt).not.toContain("paid/mutating commands stay gated");
  });

  it("never widens an explicit allow-list even when wired", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      allowedCapabilities: ["read/search files"],
      brokerWired: true,
    });
    expect(prompt).toContain("read/search files");
    expect(prompt).not.toContain("parent-agent bridge");
  });
});

describe("buildGoalPrompt Cloud app descriptor (#14119)", () => {
  const baseInput = { agentName: "Ada", goal: "ship the thing" };

  it("omits the Cloud app line when no cloudAppId is bound", () => {
    expect(buildGoalPrompt(baseInput)).not.toContain("Cloud app:");
    expect(buildGoalPrompt({ ...baseInput, cloudAppId: "   " })).not.toContain(
      "Cloud app:",
    );
  });

  it("renders the bound Cloud app id in the Workspace descriptor", () => {
    const prompt = buildGoalPrompt({
      ...baseInput,
      workdir: "/repo",
      cloudAppId: "app_abc",
    });
    expect(prompt).toContain("--- Workspace ---");
    expect(prompt).toContain("Cloud app: app_abc");
    expect(prompt).toContain("apps.get/apps.update");
    expect(prompt).toContain("instead of creating a new one");
  });

  it("renders the Workspace section even with no workdir/repo when only a Cloud app is bound", () => {
    const prompt = buildGoalPrompt({ ...baseInput, cloudAppId: "app_only" });
    expect(prompt).toContain("--- Workspace ---");
    expect(prompt).toContain("Cloud app: app_only");
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
