import type { Tab } from "../navigation";
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

  // Guard against companion-only tabs leaking into native/desktop mode.
  // lastNativeTab should already be sanitized by normalizeLastNativeTab,
  // but be defensive: character-select and companion are never valid here.
  if (lastNativeTab === "character-select" || lastNativeTab === "companion") {
    return "chat";
  }

  return lastNativeTab;
}

export function shouldStartAtCharacterSelectOnLaunch(_params: {
  onboardingNeedsOptions: boolean;
  onboardingMode: OnboardingMode;
  navPath: string;
  urlTab: Tab | null;
}): boolean {
  return false;
}
