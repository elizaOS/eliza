import type { Tab } from "../navigation";
import { COMPANION_ENABLED } from "../navigation";
import type { OnboardingMode, ShellView } from "./types";
import type { UiShellMode } from "./ui-preferences";

export function deriveUiShellModeForTab(tab: Tab): UiShellMode {
  return tab === "companion" ? "companion" : "native";
}

export function getTabForShellView(view: ShellView, lastNativeTab: Tab): Tab {
  if (view === "companion") {
    return "companion";
  }

  if (view === "character") {
    return "character";
  }

  return lastNativeTab;
}

export function shouldStartAtCharacterSelectOnLaunch(params: {
  onboardingNeedsOptions: boolean;
  onboardingMode: OnboardingMode;
  navPath: string;
  urlTab: Tab | null;
}): boolean {
  // Character-select is a companion-only feature.
  if (!COMPANION_ENABLED) return false;

  const { onboardingNeedsOptions, onboardingMode } = params;
  if (onboardingNeedsOptions || onboardingMode === "elizacloudonly") {
    return false;
  }

  // Don't auto-redirect to character-select — existing users should land
  // on companion chat with their configured character. Character-select is
  // only reached by explicit navigation (e.g. from the shell view toggle).
  return false;
}
