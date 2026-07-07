// Self-contained fixture for the settings hub e2e: mounts the REAL
// SettingsView over the REAL section registry (settings-sections.ts), so the
// hub row list, hub → subview navigation, hash deep-links, and the per-section
// error boundaries are all exercised against production code. Only the
// `state`/`api` barrels and @elizaos/core are stubbed (see
// settings-fixture-state-stub.ts and the runner's esbuild plugins) — a section
// whose body needs live data degrades to its designed loading/error state,
// which is itself part of what the walkthrough captures. Paired with
// run-settings-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";
import { SettingsView } from "../SettingsView";

function Harness(): React.JSX.Element {
  return (
    <div className="min-h-screen w-full bg-bg text-txt">
      <SettingsView />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
