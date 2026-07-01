// Integration fixture for the unified app-background e2e. Mounts the REAL
// always-mounted AppBackground (which installs the real `background:apply`
// chat→background bridge) and drives it through real controls — preset swatches,
// a real file input fed through the real `fileToBackgroundDataUrl`, and an undo
// button — all wired to one store with the real push/pop history semantics.
//
// Kept to a browser-safe import graph on purpose (no `client`/`persistence`),
// so esbuild can bundle it for the browser. The real BackgroundView DOM is
// covered by BackgroundView.test.tsx; the real history math by
// useDisplayPreferences.background.test.tsx. This proves the rendered pipeline:
// store → AppBackground (shader/image), agent event → bridge → store, and undo.

import * as React from "react";
import { useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBackground } from "../../../backgrounds/AppBackground";
import { __setAppValueForTests } from "../../../state/app-store";
import {
  BACKGROUND_PRESETS,
  type BackgroundConfig,
  backgroundConfigsEqual,
  DEFAULT_BACKGROUND_CONFIG,
} from "../../../state/ui-preferences";
import { emitViewEvent } from "../../../views/view-event-bus";
import { fileToBackgroundDataUrl } from "../background-image";

type Win = typeof window & {
  __emitBgApply?: (payload: Record<string, unknown>) => void;
};

const MAX_HISTORY = 10;

function seed(
  config: BackgroundConfig,
  history: BackgroundConfig[],
  set: (c: BackgroundConfig) => void,
  undo: () => void,
) {
  __setAppValueForTests({
    backgroundConfig: config,
    canUndoBackground: history.length > 0,
    setBackgroundConfig: set,
    undoBackgroundConfig: undo,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
  } as never);
}

// Seed before first paint so store-backed selectors never read an empty store.
seed(DEFAULT_BACKGROUND_CONFIG, [], () => {}, () => {});

function Harness(): React.JSX.Element {
  const [config, setConfig] = useState<BackgroundConfig>(
    DEFAULT_BACKGROUND_CONFIG,
  );
  const [history, setHistory] = useState<BackgroundConfig[]>([]);

  // Real push-on-change history, mirroring useDisplayPreferences.
  const setBackgroundConfig = useCallback((next: BackgroundConfig) => {
    setConfig((prev) => {
      if (backgroundConfigsEqual(prev, next)) return prev;
      setHistory((h) => [...h, prev].slice(-MAX_HISTORY));
      return next;
    });
  }, []);
  const undoBackgroundConfig = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setConfig(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, []);

  // Mirror into the store every render so AppBackground + its bridge resolve to
  // this one source of truth (the production wiring).
  useLayoutEffect(() => {
    seed(config, history, setBackgroundConfig, undoBackgroundConfig);
  }, [config, history, setBackgroundConfig, undoBackgroundConfig]);

  useLayoutEffect(() => {
    (window as Win).__emitBgApply = (payload) =>
      emitViewEvent("background:apply", payload, "agent");
  }, []);

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
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
