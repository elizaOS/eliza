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
    return COMPANION_ENABLED ? "character-select" : lastNativeTab;
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

  const { onboardingNeedsOptions, onboardingMode, navPath, urlTab } = params;
  if (onboardingNeedsOptions || onboardingMode === "elizacloudonly") {
    return false;
  }

  // Only redirect generic landing pages to character-select; an explicit
  // /companion URL should stay on the companion view.
  return navPath === "/" || urlTab === "chat";
}
