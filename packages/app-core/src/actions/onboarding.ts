/**
 * Onboarding step constants and helpers — extracted from AppContext.
 * @deprecated Use types from state/types.ts instead.
 */

export type OnboardingStep = "welcome" | "cloudLogin" | "saveKeys";

export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  "welcome",
  "cloudLogin",
  "saveKeys",
];

export interface OnboardingNextOptions {
  allowPermissionBypass?: boolean;
}

export const ONBOARDING_PERMISSION_LABELS: Record<string, string> = {
  accessibility: "Accessibility",
  "screen-recording": "Screen Recording",
  microphone: "Microphone",
};

export function getNextOnboardingStep(
  current: OnboardingStep,
): OnboardingStep | null {
  const idx = ONBOARDING_STEP_ORDER.indexOf(current);
  if (idx < 0 || idx >= ONBOARDING_STEP_ORDER.length - 1) return null;
  return ONBOARDING_STEP_ORDER[idx + 1];
}

export function getPreviousOnboardingStep(
  current: OnboardingStep,
): OnboardingStep | null {
  const idx = ONBOARDING_STEP_ORDER.indexOf(current);
  if (idx <= 0) return null;
  return ONBOARDING_STEP_ORDER[idx - 1];
}
