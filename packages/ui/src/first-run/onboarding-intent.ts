/**
 * onboarding-intent — the shared contract for driving first-run setup from
 * non-form surfaces (the tray menu and the voice pill), so both dispatch the
 * same runtime choice into the existing first-run controller.
 *
 * The voice path already parses spoken commands into a runtime choice
 * (applyFirstRunVoiceTranscript in ./first-run). This is the tray side:
 * stable item ids + label keys for the onboarding tray entries, and a mapping
 * from a clicked tray action id back to the runtime choice. The compact
 * onboarding overlay dispatches the resolved choice into the controller.
 */

/** The runtime a user picks during first-run (cloud sign-in needs a gesture). */
export type OnboardingRuntimeChoice = "local" | "cloud" | "remote";

export interface OnboardingTrayItem {
  /** Stable tray action id (routed in DesktopTrayRuntime). */
  id: string;
  /** Default English label. */
  label: string;
  /** i18n key resolved at menu-build time. */
  labelKey: string;
  /** The runtime choice this item selects. */
  choice: OnboardingRuntimeChoice;
}

/**
 * Tray items shown only while first-run setup is pending. "No default — ask":
 * local and cloud are presented as equal peers. Cloud completes via the OAuth
 * popup, which a tray click (a real user gesture) satisfies.
 */
export const ONBOARDING_TRAY_ITEMS: readonly OnboardingTrayItem[] = [
  {
    id: "onboard-use-local",
    label: "Use Local (on-device)",
    labelKey: "desktop.onboarding.useLocal",
    choice: "local",
  },
  {
    id: "onboard-sign-in-cloud",
    label: "Sign in to Eliza Cloud",
    labelKey: "desktop.onboarding.signInCloud",
    choice: "cloud",
  },
] as const;

/** Map a clicked tray action id to its onboarding runtime choice, or null. */
export function trayActionToOnboardingChoice(
  id: string,
): OnboardingRuntimeChoice | null {
  return ONBOARDING_TRAY_ITEMS.find((item) => item.id === id)?.choice ?? null;
}

/** True when the tray action id is an onboarding choice (vs a normal item). */
export function isOnboardingTrayAction(id: string): boolean {
  return trayActionToOnboardingChoice(id) !== null;
}
