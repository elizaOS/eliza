/**
 * Display preferences — theme and companion rendering settings.
 *
 * Extracted from AppContext. Each preference persists to localStorage
 * and normalizes on set.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyUiTheme,
  getSystemTheme,
  loadBackgroundConfig,
  loadBackgroundHistory,
  loadCompanionAnimateWhenHidden,
  loadCompanionHalfFramerateMode,
  loadCompanionVrmPowerMode,
  loadUiThemeMode,
  MAX_BACKGROUND_HISTORY,
  normalizeBackgroundConfig,
  normalizeCompanionHalfFramerateMode,
  normalizeCompanionVrmPowerMode,
  normalizeUiThemeMode,
  resolveUiTheme,
  saveBackgroundConfig,
  saveBackgroundHistory,
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
import {
  type BackgroundConfig,
  backgroundConfigsEqual,
  type UiTheme,
  type UiThemeMode,
} from "./ui-preferences";

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
  // Bounded undo stack: the previous configs, most-recent last. Refs mirror the
  // latest values so the set/undo callbacks stay identity-stable ([] deps) while
  // never reading stale state.
  const [backgroundHistory, setBackgroundHistoryState] = useState<
    BackgroundConfig[]
  >(loadBackgroundHistory);
  const backgroundConfigRef = useRef(backgroundConfig);
  backgroundConfigRef.current = backgroundConfig;
  const backgroundHistoryRef = useRef(backgroundHistory);
  backgroundHistoryRef.current = backgroundHistory;

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

  // Setting pushes the outgoing config onto the undo stack (unless unchanged).
  const setBackgroundConfig = useCallback((config: BackgroundConfig) => {
    const next = normalizeBackgroundConfig(config);
    const prev = backgroundConfigRef.current;
    if (backgroundConfigsEqual(prev, next)) return;
    setBackgroundHistoryState((h) =>
      [...h, prev].slice(-MAX_BACKGROUND_HISTORY),
    );
    setBackgroundConfigState(next);
  }, []);

  // Undo restores the most recent previous config and pops it off the stack.
  // There is no redo — stepping back simply discards the undone config.
  const undoBackgroundConfig = useCallback(() => {
    const history = backgroundHistoryRef.current;
    if (history.length === 0) return;
    setBackgroundConfigState(history[history.length - 1]);
    setBackgroundHistoryState((h) => h.slice(0, -1));
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

  useEffect(() => {
    saveBackgroundHistory(backgroundHistory);
  }, [backgroundHistory]);

  return {
    state: {
      uiTheme,
      uiThemeMode,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
      backgroundConfig,
      canUndoBackground: backgroundHistory.length > 0,
    },
    setUiTheme,
    setUiThemeMode,
    setCompanionVrmPowerMode,
    setCompanionAnimateWhenHidden,
    setCompanionHalfFramerateMode,
    setBackgroundConfig,
    undoBackgroundConfig,
  };
}
