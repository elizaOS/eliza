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
  loadUiTheme,
  normalizeCompanionHalfFramerateMode,
  normalizeCompanionVrmPowerMode,
  normalizeUiTheme,
  saveCompanionAnimateWhenHidden,
  saveCompanionHalfFramerateMode,
  saveCompanionVrmPowerMode,
  saveUiTheme,
} from "./persistence";
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "./types";
import type { UiTheme } from "./ui-preferences";

export function useDisplayPreferences() {
  const [uiTheme, setUiThemeState] = useState<UiTheme>(loadUiTheme);
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
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
    },
    setUiTheme,
    setCompanionVrmPowerMode,
    setCompanionAnimateWhenHidden,
    setCompanionHalfFramerateMode,
  };
}
