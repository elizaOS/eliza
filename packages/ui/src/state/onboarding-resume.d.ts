import type { BuildOnboardingConnectionArgs } from "@elizaos/app-core";
import type { OnboardingStep } from "./types";
export declare function hasPartialOnboardingConnectionConfig(
  config: Record<string, unknown> | null | undefined,
): boolean;
export declare function inferOnboardingResumeStep(args: {
  config?: Record<string, unknown> | null;
  persistedStep?: OnboardingStep | null;
}): OnboardingStep;
export declare function deriveOnboardingResumeFieldsFromConfig(
  config: Record<string, unknown> | null | undefined,
): Partial<BuildOnboardingConnectionArgs>;
//# sourceMappingURL=onboarding-resume.d.ts.map
