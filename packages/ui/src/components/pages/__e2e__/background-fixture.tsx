// Integration fixture for the unified app-background e2e. Mounts the REAL
// always-mounted AppBackground (which installs the real `background:apply`
// chat→background bridge) and drives it through real controls — preset swatches,
// a real file input fed through the real `fileToBackgroundDataUrl`, and
// undo/redo buttons.
//
// The set/undo/redo history uses the SAME pure reducer production does
// (state/background-history: applyBackgroundSet/Undo/Redo) rather than a
// hand-mirrored copy, so mirror-vs-real drift is impossible (#10694). That
// reducer is deliberately persistence-free, so this stays a browser-safe
// import graph esbuild can bundle (no `client`/`persistence`). The real
// BackgroundView DOM is covered by BackgroundView.test.tsx; the reducer math by
// state/__tests__/background-history.test.ts; the persisted round-trip by
// useDisplayPreferences.background.test.tsx. This fixture proves the rendered
// pipeline: store → AppBackground (shader/image), agent event → bridge → store,
// undo, and redo.

import * as React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BACKGROUND_APPLY_EVENT } from "@elizaos/shared/events";
import { AppBackground } from "../../../backgrounds/AppBackground";
import {
  applyBackgroundRedo,
  applyBackgroundSet,
  applyBackgroundUndo,
  type BackgroundHistoryState,
} from "../../../state/background-history";
import { __setAppValueForTests } from "../../../state/app-store";
import {
  BACKGROUND_PRESETS,
  type BackgroundConfig,
} from "../../../state/ui-preferences";
import { emitViewEvent } from "../../../views/view-event-bus";
import { fileToBackgroundDataUrl } from "../background-image";

type Win = typeof window & {
  __emitBgApply?: (payload: Record<string, unknown>) => void;
  __getBgState?: () => {
    config: BackgroundConfig;
    history: BackgroundConfig[];
    redo: BackgroundConfig[];
  };
};

// This e2e exercises shader, image, undo/redo, and GLSL transitions over
// file://. Keep the starting point as an explicit shader so the served-image
// production default does not depend on app public assets in the fixture.
const ORANGE_PRESET = BACKGROUND_PRESETS.find((preset) => preset.id === "orange");
if (!ORANGE_PRESET) {
  throw new Error('Missing "orange" background preset for background e2e');
}
const INITIAL_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "shader",
  color: ORANGE_PRESET.color,
};

function seed(
  config: BackgroundConfig,
  history: BackgroundConfig[],
  redoStack: BackgroundConfig[],
  set: (c: BackgroundConfig) => void,
  undo: () => void,
  redo: () => void,
) {
  __setAppValueForTests({
    backgroundConfig: config,
    canUndoBackground: history.length > 0,
    canRedoBackground: redoStack.length > 0,
    setBackgroundConfig: set,
    undoBackgroundConfig: undo,
    redoBackgroundConfig: redo,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
  } as never);
}

// Seed before first paint so store-backed selectors never read an empty store.
seed(INITIAL_BACKGROUND_CONFIG, [], [], () => {}, () => {}, () => {});

function Harness(): React.JSX.Element {
  const [config, setConfig] = useState<BackgroundConfig>(
    INITIAL_BACKGROUND_CONFIG,
  );
  const [history, setHistory] = useState<BackgroundConfig[]>([]);
  const [redoStack, setRedoStack] = useState<BackgroundConfig[]>([]);

  // Refs mirror the latest values so the callbacks stay identity-stable without
  // reading stale state.
  const configRef = useRef(config);
  configRef.current = config;
  const historyRef = useRef(history);
  historyRef.current = history;
  const redoRef = useRef(redoStack);
  redoRef.current = redoStack;

  // set / undo / redo delegate to the SAME pure reducer production uses
  // (state/background-history), so this e2e can no longer drift from the real
  // history semantics by hand-mirroring them (#10694).
  const snapshot = useCallback(
    (): BackgroundHistoryState => ({
      config: configRef.current,
      history: historyRef.current,
      redo: redoRef.current,
    }),
    [],
  );
  const applyState = useCallback((s: BackgroundHistoryState) => {
    setConfig(s.config);
    setHistory(s.history);
    setRedoStack(s.redo);
  }, []);
  const setBackgroundConfig = useCallback(
    (next: BackgroundConfig) => applyState(applyBackgroundSet(snapshot(), next)),
    [applyState, snapshot],
  );
  const undoBackgroundConfig = useCallback(
    () => applyState(applyBackgroundUndo(snapshot())),
    [applyState, snapshot],
  );
  const redoBackgroundConfig = useCallback(
    () => applyState(applyBackgroundRedo(snapshot())),
    [applyState, snapshot],
  );

  // Mirror into the store every render so AppBackground + its bridge resolve to
  // this one source of truth (the production wiring).
  useLayoutEffect(() => {
    seed(
      config,
      history,
      redoStack,
      setBackgroundConfig,
      undoBackgroundConfig,
      redoBackgroundConfig,
    );
  }, [
    config,
    history,
    redoStack,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
  ]);

  useLayoutEffect(() => {
    (window as Win).__emitBgApply = (payload) =>
      emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "agent");
  }, []);

  useLayoutEffect(() => {
    (window as Win).__getBgState = () => ({
      config: configRef.current,
      history: historyRef.current,
      redo: redoRef.current,
    });
  }, [config, history, redoStack]);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const imageUrl = await fileToBackgroundDataUrl(file);
      setBackgroundConfig({ mode: "image", color: config.color, imageUrl });
    },
    [config.color, setBackgroundConfig],
  );

  return (
    <div
      data-testid="bg-fixture-root"
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <AppBackground />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          padding: 24,
          maxWidth: 420,
          margin: "24px auto",
          borderRadius: 24,
          background: "rgba(255,255,255,0.55)",
          backdropFilter: "blur(16px)",
        }}
      >
        {BACKGROUND_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-label={`Set background to ${preset.label}`}
            onClick={() =>
              setBackgroundConfig({ mode: "shader", color: preset.color })
            }
            style={{
              width: 36,
              height: 36,
              borderRadius: "9999px",
              background: preset.color,
              border: "1px solid rgba(0,0,0,0.15)",
            }}
          />
        ))}
        <input
          type="file"
          accept="image/*"
          aria-label="Background image file"
          onChange={onFile}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
        />
        {history.length > 0 ? (
          <button
            type="button"
            aria-label="Undo background change"
            onClick={() => undoBackgroundConfig()}
            style={{ height: 36, padding: "0 14px", borderRadius: 12 }}
          >
            Undo
          </button>
        ) : null}
        {redoStack.length > 0 ? (
          <button
            type="button"
            aria-label="Redo background change"
            onClick={() => redoBackgroundConfig()}
            style={{ height: 36, padding: "0 14px", borderRadius: 12 }}
          >
            Redo
          </button>
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
