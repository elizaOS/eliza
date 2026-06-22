// Self-contained fixture for the unified app-background e2e: mounts the real
// AppBackground (the single, persistent background layer) and drives its config
// store the same way the Background view does — proving the layer renders every
// mode (shader color / cover image) and recolors live without a remount. Paired
// with run-background-e2e.mjs.

import * as React from "react";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBackground } from "../../../backgrounds/AppBackground";
import { __setAppValueForTests } from "../../../state/app-store";
import type { BackgroundConfig } from "../../../state/ui-preferences";

type Win = typeof window & {
  __setBg?: (config: BackgroundConfig) => void;
};

function seed(config: BackgroundConfig) {
  __setAppValueForTests({
    backgroundConfig: config,
    setBackgroundConfig: () => {},
  } as never);
}

// Seed before first paint so the store-backed selector never reads an empty store.
seed({ mode: "shader", color: "#ef5a1f" });

function Harness(): React.JSX.Element {
  const [config, setConfig] = useState<BackgroundConfig>({
    mode: "shader",
    color: "#ef5a1f",
  });

  useLayoutEffect(() => {
    seed(config);
  }, [config]);

  useLayoutEffect(() => {
    (window as Win).__setBg = (next) => setConfig(next);
  }, []);

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
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
