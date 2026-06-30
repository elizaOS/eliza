import type { Tab } from "../navigation";
import type { FirstRunMode, ShellView } from "./types";
import type { UiShellMode } from "./ui-preferences";

export function deriveUiShellModeForTab(_tab: Tab): UiShellMode {
  return "native";
}

export function getTabForShellView(view: ShellView, lastNativeTab: Tab): Tab {
  if (view === "character") {
    return "character";
  }

  // Guard against the character-select tab leaking into native/desktop mode.
  // lastNativeTab should already be sanitized by normalizeLastNativeTab,
  // but be defensive: character-select is never valid here.
  if (lastNativeTab === "character-select") {
    return "chat";
  }

  return lastNativeTab;
}

export function shouldStartAtCharacterSelectOnLaunch(_params: {
  firstRunNeedsOptions: boolean;
  firstRunMode: FirstRunMode;
  navPath: string;
  urlTab: Tab | null;
}): boolean {
  return false;
}
