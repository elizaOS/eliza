/**
 * Display preferences — theme and companion rendering settings.
 *
 * Extracted from AppContext. Each preference persists to localStorage
 * and normalizes on set.
 */

import { useCallback, useEffect, useState } from "react";
import {
  applyUiTheme,
  loadCompanionAnimateWhenHidden,
  loadCompanionHalfFramerateMode,
  loadCompanionVrmPowerMode,
  loadThemeId,
  loadUiTheme,
  normalizeCompanionHalfFramerateMode,
  normalizeCompanionVrmPowerMode,
  normalizeUiTheme,
  saveCompanionAnimateWhenHidden,
  saveCompanionHalfFramerateMode,
  saveCompanionVrmPowerMode,
  saveThemeId,
  saveUiTheme,
} from "./persistence";
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "./types";
import type { UiTheme } from "./ui-preferences";

export function useDisplayPreferences() {
  const [uiTheme, setUiThemeState] = useState<UiTheme>(loadUiTheme);
  const [themeId, setThemeIdState] = useState<string>(loadThemeId);
  const [companionVrmPowerMode, setCompanionVrmPowerModeState] =
    useState<CompanionVrmPowerMode>(loadCompanionVrmPowerMode);
  const [companionAnimateWhenHidden, setCompanionAnimateWhenHiddenState] =
    useState<boolean>(loadCompanionAnimateWhenHidden);
  const [companionHalfFramerateMode, setCompanionHalfFramerateModeState] =
    useState<CompanionHalfFramerateMode>(loadCompanionHalfFramerateMode);

  // Normalize + persist wrappers
  const setUiTheme = useCallback((theme: UiTheme) => {
    setUiThemeState(normalizeUiTheme(theme));
  }, []);

  const setThemeId = useCallback((id: string) => {
    setThemeIdState(id);
  }, []);

  const setCompanionVrmPowerMode = useCallback(
    (mode: CompanionVrmPowerMode) => {
      setCompanionVrmPowerModeState(normalizeCompanionVrmPowerMode(mode));
    },
    [],
  );

  const setCompanionAnimateWhenHidden = useCallback((enabled: boolean) => {
    setCompanionAnimateWhenHiddenState(enabled);
  }, []);

  const setCompanionHalfFramerateMode = useCallback(
    (mode: CompanionHalfFramerateMode) => {
      setCompanionHalfFramerateModeState(
        normalizeCompanionHalfFramerateMode(mode),
      );
    },
    [],
  );

  // Persist effects
  useEffect(() => {
    saveUiTheme(uiTheme);
    applyUiTheme(uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    saveThemeId(themeId);
    // Re-apply the UI theme to trigger theme color set application
    applyUiTheme(uiTheme);
  }, [themeId, uiTheme]);

  useEffect(() => {
    saveCompanionVrmPowerMode(companionVrmPowerMode);
  }, [companionVrmPowerMode]);

  useEffect(() => {
    saveCompanionAnimateWhenHidden(companionAnimateWhenHidden);
  }, [companionAnimateWhenHidden]);

  useEffect(() => {
    saveCompanionHalfFramerateMode(companionHalfFramerateMode);
  }, [companionHalfFramerateMode]);

  return {
    state: {
      uiTheme,
      themeId,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
    },
    setUiTheme,
    setThemeId,
    setCompanionVrmPowerMode,
    setCompanionAnimateWhenHidden,
    setCompanionHalfFramerateMode,
  };
}
