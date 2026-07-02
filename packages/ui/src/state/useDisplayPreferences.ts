/**
 * Display preferences — theme and background settings.
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
  loadBackgroundRedo,
  loadHomeTimeWidgetHidden,
  loadUiThemeMode,
  MAX_BACKGROUND_HISTORY,
  normalizeBackgroundConfig,
  normalizeUiThemeMode,
  resolveUiTheme,
  saveBackgroundConfig,
  saveBackgroundHistory,
  saveBackgroundRedo,
  saveHomeTimeWidgetHidden,
  saveUiTheme,
  saveUiThemeMode,
} from "./persistence";
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
  const [backgroundConfig, setBackgroundConfigState] =
    useState<BackgroundConfig>(loadBackgroundConfig);
  // Bounded undo stack: the previous configs, most-recent last. Refs mirror the
  // latest values so the set/undo callbacks stay identity-stable ([] deps) while
  // never reading stale state.
  const [backgroundHistory, setBackgroundHistoryState] = useState<
    BackgroundConfig[]
  >(loadBackgroundHistory);
  // Bounded REDO stack (#10694): configs that were undone, most-recent last, so
  // "step back if you don't like it" can also step forward. Persisted
  // symmetrically with the undo history (issue deliverable: "undo + redo,
  // bounded, persisted") so it survives reload; cleared by any new edit.
  const [backgroundRedo, setBackgroundRedoState] =
    useState<BackgroundConfig[]>(loadBackgroundRedo);
  // Home time/date tile visibility (#10706): shown by default, hideable from
  // Appearance settings, persisted across reload.
  const [homeTimeWidgetHidden, setHomeTimeWidgetHiddenState] =
    useState<boolean>(loadHomeTimeWidgetHidden);
  const backgroundConfigRef = useRef(backgroundConfig);
  backgroundConfigRef.current = backgroundConfig;
  const backgroundHistoryRef = useRef(backgroundHistory);
  backgroundHistoryRef.current = backgroundHistory;
  const backgroundRedoRef = useRef(backgroundRedo);
  backgroundRedoRef.current = backgroundRedo;

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

  const setHomeTimeWidgetHidden = useCallback((hidden: boolean) => {
    setHomeTimeWidgetHiddenState(hidden);
  }, []);

  // Setting pushes the outgoing config onto the undo stack (unless unchanged),
  // and clears the redo stack — a new edit invalidates the redo future.
  const setBackgroundConfig = useCallback((config: BackgroundConfig) => {
    const next = normalizeBackgroundConfig(config);
    const prev = backgroundConfigRef.current;
    if (backgroundConfigsEqual(prev, next)) return;
    setBackgroundHistoryState((h) =>
      [...h, prev].slice(-MAX_BACKGROUND_HISTORY),
    );
    setBackgroundRedoState((r) => (r.length ? [] : r));
    setBackgroundConfigState(next);
  }, []);

  // Undo restores the most recent previous config, pops it off the undo stack,
  // and pushes the now-undone current config onto the redo stack (#10694).
  const undoBackgroundConfig = useCallback(() => {
    const history = backgroundHistoryRef.current;
    if (history.length === 0) return;
    const current = backgroundConfigRef.current;
    setBackgroundRedoState((r) =>
      [...r, current].slice(-MAX_BACKGROUND_HISTORY),
    );
    setBackgroundConfigState(history[history.length - 1]);
    setBackgroundHistoryState((h) => h.slice(0, -1));
  }, []);

  // Redo re-applies the most recently undone config and pushes the current one
  // back onto the undo stack — the forward half of undo/redo (#10694).
  const redoBackgroundConfig = useCallback(() => {
    const redo = backgroundRedoRef.current;
    if (redo.length === 0) return;
    const current = backgroundConfigRef.current;
    setBackgroundHistoryState((h) =>
      [...h, current].slice(-MAX_BACKGROUND_HISTORY),
    );
    setBackgroundConfigState(redo[redo.length - 1]);
    setBackgroundRedoState((r) => r.slice(0, -1));
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
    saveBackgroundConfig(backgroundConfig);
  }, [backgroundConfig]);

  useEffect(() => {
    saveBackgroundHistory(backgroundHistory);
  }, [backgroundHistory]);

  useEffect(() => {
    saveBackgroundRedo(backgroundRedo);
  }, [backgroundRedo]);

  useEffect(() => {
    saveHomeTimeWidgetHidden(homeTimeWidgetHidden);
  }, [homeTimeWidgetHidden]);

  return {
    state: {
      uiTheme,
      uiThemeMode,
      backgroundConfig,
      canUndoBackground: backgroundHistory.length > 0,
      canRedoBackground: backgroundRedo.length > 0,
      homeTimeWidgetHidden,
    },
    setUiTheme,
    setUiThemeMode,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
    setHomeTimeWidgetHidden,
  };
}
