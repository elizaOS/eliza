/**
 * Display preferences — theme and companion rendering settings.
 *
 * Extracted from AppContext. Each preference persists to localStorage
 * and normalizes on set.
 */
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "./types";
import type { UiTheme } from "./ui-preferences";
export declare function useDisplayPreferences(): {
  state: {
    uiTheme: UiTheme;
    companionVrmPowerMode: CompanionVrmPowerMode;
    companionAnimateWhenHidden: boolean;
    companionHalfFramerateMode: CompanionHalfFramerateMode;
  };
  setUiTheme: (theme: UiTheme) => void;
  setCompanionVrmPowerMode: (mode: CompanionVrmPowerMode) => void;
  setCompanionAnimateWhenHidden: (enabled: boolean) => void;
  setCompanionHalfFramerateMode: (mode: CompanionHalfFramerateMode) => void;
};
//# sourceMappingURL=useDisplayPreferences.d.ts.map
