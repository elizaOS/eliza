import type { Tab } from "../navigation";
import type { ShellView } from "./types";
import type { UiShellMode } from "./ui-preferences";

export function deriveUiShellModeForTab(tab: Tab): UiShellMode {
  return tab === "companion" ? "companion" : "native";
}

export function getTabForShellView(view: ShellView, lastNativeTab: Tab): Tab {
  if (view === "companion") {
    return "companion";
  }

  if (view === "character") {
    return "character-select";
  }

  return lastNativeTab;
}

export function shouldStartAtCharacterSelectOnLaunch(params: {
  onboardingNeedsOptions: boolean;
  navPath: string;
  urlTab: Tab | null;
}): boolean {
  const { onboardingNeedsOptions, navPath, urlTab } = params;
  if (onboardingNeedsOptions) {
    return false;
  }

  return navPath === "/" || urlTab === "chat" || urlTab === "companion";
}
