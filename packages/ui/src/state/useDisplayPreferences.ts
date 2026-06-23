/**
 * Display preferences — theme and companion rendering settings.
 *
 * Extracted from AppContext. Each preference persists to localStorage
 * and normalizes on set.
 */

import { useCallback, useEffect, useState } from "react";
import {
  applyUiTheme,
  getSystemTheme,
  loadBackgroundConfig,
  loadCompanionAnimateWhenHidden,
  loadCompanionHalfFramerateMode,
  loadCompanionVrmPowerMode,
  loadUiThemeMode,
  normalizeBackgroundConfig,
  normalizeCompanionHalfFramerateMode,
  normalizeCompanionVrmPowerMode,
  normalizeUiThemeMode,
  resolveUiTheme,
  saveBackgroundConfig,
  saveCompanionAnimateWhenHidden,
  saveCompanionHalfFramerateMode,
  saveCompanionVrmPowerMode,
  saveUiTheme,
  saveUiThemeMode,
} from "./persistence";
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
} from "./types";
import type { BackgroundConfig, UiTheme, UiThemeMode } from "./ui-preferences";

export function useDisplayPreferences() {
  const [uiThemeMode, setUiThemeModeState] =
    useState<UiThemeMode>(loadUiThemeMode);
  const [uiTheme, setUiThemeState] = useState<UiTheme>(() =>
    resolveUiTheme(loadUiThemeMode()),
  );
  const [companionVrmPowerMode, setCompanionVrmPowerModeState] =
    useState<CompanionVrmPowerMode>(loadCompanionVrmPowerMode);
  const [companionAnimateWhenHidden, setCompanionAnimateWhenHiddenState] =
    useState<boolean>(loadCompanionAnimateWhenHidden);
  const [companionHalfFramerateMode, setCompanionHalfFramerateModeState] =
    useState<CompanionHalfFramerateMode>(loadCompanionHalfFramerateMode);
  const [backgroundConfig, setBackgroundConfigState] =
    useState<BackgroundConfig>(loadBackgroundConfig);

  // Normalize + persist wrappers
  const setUiThemeMode = useCallback((mode: UiThemeMode) => {
    setUiThemeModeState(normalizeUiThemeMode(mode));
  }, []);

  // Picking an explicit light/dark from the UI sets the mode to that choice.
  const setUiTheme = useCallback(
    (theme: UiTheme) => {
      setUiThemeMode(theme);
    },
    [setUiThemeMode],
  );

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

  const setBackgroundConfig = useCallback((config: BackgroundConfig) => {
    setBackgroundConfigState(normalizeBackgroundConfig(config));
  }, []);

  // Resolve mode -> concrete theme. When following the system, track OS
  // color-scheme changes live.
  useEffect(() => {
    if (uiThemeMode !== "system") {
      setUiThemeState(uiThemeMode);
      return;
    }
    setUiThemeState(getSystemTheme());
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setUiThemeState(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [uiThemeMode]);

  // Persist effects
  useEffect(() => {
    saveUiThemeMode(uiThemeMode);
  }, [uiThemeMode]);

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

  useEffect(() => {
    saveBackgroundConfig(backgroundConfig);
  }, [backgroundConfig]);

  return {
    state: {
      uiTheme,
      uiThemeMode,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
      backgroundConfig,
    },
    setUiTheme,
    setUiThemeMode,
    setCompanionVrmPowerMode,
    setCompanionAnimateWhenHidden,
    setCompanionHalfFramerateMode,
    setBackgroundConfig,
  };
}
