import type { Tab } from "../navigation";
import type { OnboardingMode, ShellView } from "./types";
import type { UiShellMode } from "./ui-preferences";
export declare function deriveUiShellModeForTab(tab: Tab): UiShellMode;
export declare function getTabForShellView(
  view: ShellView,
  lastNativeTab: Tab,
): Tab;
export declare function shouldStartAtCharacterSelectOnLaunch(_params: {
  onboardingNeedsOptions: boolean;
  onboardingMode: OnboardingMode;
  navPath: string;
  urlTab: Tab | null;
}): boolean;
//# sourceMappingURL=shell-routing.d.ts.map
