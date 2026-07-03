/**
 * Display preferences — theme and background settings.
 *
 * Extracted from AppContext. Each preference persists to localStorage
 * and normalizes on set.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyBackgroundRedo,
  applyBackgroundSet,
  applyBackgroundUndo,
  type BackgroundHistoryState,
} from "./background-history";
import {
  applyUiAccent,
  applyUiTheme,
  getSystemTheme,
  loadBackgroundConfig,
  loadBackgroundHistory,
  loadBackgroundRedo,
  loadHomeTimeWidgetHidden,
  loadUiAccentId,
  loadUiThemeMode,
  normalizeBackgroundConfig,
  normalizeUiThemeMode,
  resolveUiTheme,
  saveBackgroundConfig,
  saveBackgroundHistory,
  saveBackgroundRedo,
  saveHomeTimeWidgetHidden,
  saveUiAccentId,
  saveUiTheme,
  saveUiThemeMode,
} from "./persistence";
import {
  type BackgroundConfig,
  normalizeAccentId,
  resolveAccentColor,
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
  // User-chosen accent color (preset id). `default` keeps the brand accent.
  // Applied live to the `--accent` family and persisted across sessions, so
  // the first-run onboarding accent step and Appearance settings share one
  // mechanism (#onboarding-accent).
  const [uiAccentId, setUiAccentIdState] = useState<string>(loadUiAccentId);
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

  const setUiAccent = useCallback((id: string) => {
    setUiAccentIdState(normalizeAccentId(id));
  }, []);

  // A snapshot of the live {config, history, redo} for the pure reducer — refs
  // keep the callbacks identity-stable ([] deps) without reading stale state.
  const snapshot = useCallback(
    (): BackgroundHistoryState => ({
      config: backgroundConfigRef.current,
      history: backgroundHistoryRef.current,
      redo: backgroundRedoRef.current,
    }),
    [],
  );
  const applyHistoryState = useCallback((s: BackgroundHistoryState) => {
    setBackgroundConfigState(s.config);
    setBackgroundHistoryState(s.history);
    setBackgroundRedoState(s.redo);
  }, []);

  // set / undo / redo all delegate to the pure reducer (shared with the e2e
  // fixture so the two can never drift, #10694).
  const setBackgroundConfig = useCallback(
    (config: BackgroundConfig) => {
      applyHistoryState(
        applyBackgroundSet(snapshot(), normalizeBackgroundConfig(config)),
      );
    },
    [applyHistoryState, snapshot],
  );
  const undoBackgroundConfig = useCallback(() => {
    applyHistoryState(applyBackgroundUndo(snapshot()));
  }, [applyHistoryState, snapshot]);
  const redoBackgroundConfig = useCallback(() => {
    applyHistoryState(applyBackgroundRedo(snapshot()));
  }, [applyHistoryState, snapshot]);

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

  // Persist + apply the accent live. Runs on mount so a persisted accent is
  // restored on every load, and on every change so a pick applies immediately.
  useEffect(() => {
    saveUiAccentId(uiAccentId);
    applyUiAccent(resolveAccentColor(uiAccentId));
  }, [uiAccentId]);

  return {
    state: {
      uiTheme,
      uiThemeMode,
      backgroundConfig,
      canUndoBackground: backgroundHistory.length > 0,
      canRedoBackground: backgroundRedo.length > 0,
      homeTimeWidgetHidden,
      uiAccentId,
    },
    setUiTheme,
    setUiThemeMode,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
    setHomeTimeWidgetHidden,
    setUiAccent,
  };
}
