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

import { createContext, useContext } from "react";
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

export const CompanionSceneConfigCtx =
  createContext<CompanionSceneConfig | null>(null);

export function useCompanionSceneConfig(): CompanionSceneConfig {
  const ctx = useContext(CompanionSceneConfigCtx);
  if (!ctx) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
      return {
        selectedVrmIndex: 1,
        customVrmUrl: "",
        customWorldUrl: "",
        uiTheme: "dark",
        tab: "chat",
        companionVrmPowerMode: "balanced",
        companionHalfFramerateMode: "when_saving_power",
        companionAnimateWhenHidden: false,
      };
    }
    throw new Error("useCompanionSceneConfig must be used within AppProvider");
  }
  return ctx;
}
