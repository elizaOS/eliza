import { describe, expect, it } from "vitest";
import {
  canRevertOnboardingTo,
  getOnboardingNavMetas,
  getStepOrder,
  resolveOnboardingNextStep,
  resolveOnboardingPreviousStep,
} from "../flow";
import { canRunLocal } from "../../platform/init";
import { inferOnboardingResumeStep } from "../../state/onboarding-resume";

describe("onboarding flow", () => {
  it("uses the centered three-step onboarding order", () => {
    expect(getStepOrder()).toEqual(["deployment", "providers", "features"]);
  });

  it("resolves next and previous steps without an identity stage", () => {
    expect(resolveOnboardingNextStep("deployment")).toBe("providers");
    expect(resolveOnboardingNextStep("providers")).toBe("features");
    expect(resolveOnboardingNextStep("features")).toBeNull();

    expect(resolveOnboardingPreviousStep("deployment")).toBeNull();
    expect(resolveOnboardingPreviousStep("providers")).toBe("deployment");
    expect(resolveOnboardingPreviousStep("features")).toBe("providers");
  });

  it("only allows backward jumps to earlier completed steps", () => {
    expect(
      canRevertOnboardingTo({
        current: "features",
        target: "deployment",
      }),
    ).toBe(true);
    expect(
      canRevertOnboardingTo({
        current: "providers",
        target: "features",
      }),
    ).toBe(false);
  });

  it("omits deployment from the nav for cloud-only branding and local-capable runtimes", () => {
    expect(
      getOnboardingNavMetas("providers", false).map((step) => step.id),
    ).toEqual(
      canRunLocal()
        ? ["providers", "features"]
        : ["deployment", "providers", "features"],
    );
    expect(
      getOnboardingNavMetas("providers", true).map((step) => step.id),
    ).toEqual(["providers", "features"]);
  });

  it("resumes new onboarding at setup unless connection config already exists", () => {
    expect(inferOnboardingResumeStep({})).toBe("deployment");
    expect(
      inferOnboardingResumeStep({
        config: {
          deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
        },
      }),
    ).toBe("providers");
  });
});
