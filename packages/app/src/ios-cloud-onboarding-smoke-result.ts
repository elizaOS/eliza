/**
 * Completion predicate for the mobile cloud-onboarding smoke harness. The
 * renderer boot file gathers DOM, storage, and network-counter observations;
 * this module keeps the pass/fail contract pure so CI can cover the Cloud
 * first-run path without importing the full app shell.
 */

export interface IosCloudOnboardingCompletionInput {
  homeVisible: boolean;
  composerVisible: boolean;
  onboardingHidden: boolean;
  cloudActiveServer: boolean;
  firstRunPostCount: number;
}

export function isIosCloudOnboardingComplete({
  homeVisible,
  composerVisible,
  onboardingHidden,
  cloudActiveServer,
  firstRunPostCount,
}: IosCloudOnboardingCompletionInput): boolean {
  return (
    homeVisible &&
    composerVisible &&
    onboardingHidden &&
    cloudActiveServer &&
    firstRunPostCount === 1
  );
}
