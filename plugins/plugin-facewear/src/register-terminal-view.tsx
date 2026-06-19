/**
 * Register the smartglasses view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the smartglasses `viewId: "smartglasses"` declaration
 * render for real in the terminal (the unified {@link SmartglassesSpatialView})
 * rather than only navigating a GUI shell. A module-level snapshot lets a host
 * push live diagnostics; on an agent with no glasses paired it defaults to a
 * disconnected report with the next-action setup hint.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type SmartglassesSnapshot,
  SmartglassesSpatialView,
} from "./components/SmartglassesSpatialView.tsx";
import type { HardwareReport } from "./ui/SmartglassesView.helpers.ts";

const EMPTY_REPORT: HardwareReport = {
  ok: false,
  generatedAt: "",
  transport: null,
  connected: false,
  lenses: { left: "idle", right: "idle" },
  scanDiagnosis: "not_scanned",
  physicalBlocker: "not_connected",
  setupHint:
    "Connect both left and right lenses as one headset before running validation.",
  nextAction: "Connect Headset",
  serialNumber: null,
  tests: {},
  missingEvidence: [],
  events: [],
  writes: [],
  audio: [],
  wifi: { available: false, status: "Not checked", networks: [] },
  headsetState: {
    physical: null,
    battery: null,
    batteryLevels: {},
    device: null,
  },
};

const EMPTY: SmartglassesSnapshot = {
  report: EMPTY_REPORT,
  micEnabled: false,
  wifiSsid: "",
  wifiPassword: "",
  testText: "Smartglasses display test.",
  activePlatform: "desktop",
  busy: null,
  error: null,
};

let current: SmartglassesSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setSmartglassesTerminalSnapshot(
  next: SmartglassesSnapshot,
): void {
  current = next;
}

/** Register the smartglasses terminal view; returns an unregister function. */
export function registerSmartglassesTerminalView(): () => void {
  return registerSpatialTerminalView("smartglasses", () =>
    createElement(SmartglassesSpatialView, { snapshot: current }),
  );
}
