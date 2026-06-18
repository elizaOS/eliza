import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HardwareReport } from "../ui/SmartglassesView.helpers.ts";
import {
  type SmartglassesSnapshot,
  SmartglassesSpatialView,
} from "./SmartglassesSpatialView.tsx";

const report: HardwareReport = {
  ok: false,
  generatedAt: "2026-06-18T00:00:00.000Z",
  transport: "web-bluetooth",
  connected: true,
  lenses: { left: "connected", right: "prompting" },
  scanDiagnosis: "right_lens_missing",
  physicalBlocker: "evidence_missing",
  setupHint:
    "Run check, then guided validation to capture display, settings, side taps, mic writes, and audio.",
  nextAction: "Run Check and Guided Validation",
  serialNumber: "G1-AB12",
  tests: {
    headsetConnected: true,
    init: true,
    display: false,
    serial: true,
    serialObserved: false,
    settings: false,
    microphone: false,
    micEnableWrite: false,
    tapMicEnable: false,
    audio: false,
  },
  missingEvidence: ["displayPacketsSent", "settingsSent"],
  events: [
    { at: "2026-06-18T00:00:01.000Z", type: "tap", detail: "single_tap" },
    { at: "2026-06-18T00:00:02.000Z", type: "serial", detail: "G1-AB12" },
    { at: "2026-06-18T00:00:03.000Z", type: "battery", detail: "left 88%" },
  ],
  writes: [],
  audio: [],
  wifi: {
    available: true,
    status: "Connected to studio-net",
    networks: ["studio-net", "guest", "iot-vlan"],
  },
  headsetState: {
    physical: "wearing",
    battery: "discharging",
    batteryLevels: { left: 88, right: 84 },
    device: "Even G1",
  },
};

const snapshot: SmartglassesSnapshot = {
  report,
  micEnabled: true,
  wifiSsid: "studio-net",
  wifiPassword: "hunter2",
  testText: "Display ping",
  activePlatform: "desktop",
  busy: null,
  error: null,
};

const view = <SmartglassesSpatialView snapshot={snapshot} />;

describe("SmartglassesSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Smartglasses");
      expect(flat).toContain("connected");
      expect(flat).toContain("init"); // a diagnostics test row
      expect(flat).toContain("studio-net"); // wi-fi network
      expect(flat).toContain("Run Check");
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Smartglasses");
      expect(html).toContain("studio-net");
      expect(html).toContain('data-agent-id="run-check"');
      expect(html).toContain('data-agent-id="connect"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "smartglasses-test",
      () => view,
    );
    try {
      const component = getTerminalView("smartglasses-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Smartglasses");
    } finally {
      unregister();
    }
  });
});
