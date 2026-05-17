/**
 * Lightweight context for companion scene configuration.
 *
 * CompanionSceneSurface (and VrmStage via its props) only needs a small subset
 * of app state — VRM/theme/tab preferences that change rarely.  By reading from
 * this dedicated context instead of useApp(), those components avoid re-rendering
 * on unrelated state changes (WebSocket churn, chat messages, wallet updates, etc.).
 *
 * The context value is memoized in AppContext.tsx so it only propagates when
 * one of its 7 fields actually changes.
 */
import type { Tab } from "../navigation";
import type { UiTheme } from "./persistence";
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "./types";
export interface CompanionSceneConfig {
  selectedVrmIndex: number;
  customVrmUrl: string;
  customWorldUrl: string;
  uiTheme: UiTheme;
  tab: Tab;
  companionVrmPowerMode: CompanionVrmPowerMode;
  companionHalfFramerateMode: CompanionHalfFramerateMode;
  companionAnimateWhenHidden: boolean;
}
export declare const CompanionSceneConfigCtx: import("react").Context<CompanionSceneConfig | null>;
export declare function useCompanionSceneConfig(): CompanionSceneConfig;
//# sourceMappingURL=CompanionSceneConfigContext.d.ts.map
