/**
 * Facewear spatial view tests verify HTML and terminal rendering for connected
 * XR and smartglasses profile snapshots.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type FacewearSnapshot,
  FacewearSpatialView,
} from "./FacewearSpatialView.tsx";

const snapshot: FacewearSnapshot = {
  profiles: [
    {
      type: "meta-quest",
      name: "Meta Quest 3 / 3S / Pro",
      manufacturer: "Meta",
      connectionType: "WebXR",
      connected: true,
    },
    {
      type: "even-realities",
      name: "Even Realities G1 / G2",
      manufacturer: "Even Realities",
      connectionType: "Bluetooth BLE",
      connected: false,
    },
  ],
  devices: [{ id: "q1", kind: "xr", deviceType: "meta-quest" }],
  connectedCount: 1,
  loading: false,
  error: null,
};

const view = <FacewearSpatialView snapshot={snapshot} />;

describe("FacewearSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("device connected"); // header pill (singular)
      expect(flat).toContain("Meta Quest"); // a device row
      expect(flat).toContain("Refresh"); // quick action
      expect(flat).toContain("devices"); // the devices divider
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
      expect(html).toContain("Meta Quest");
      expect(html).toContain('data-agent-id="connect:meta-quest"');
      expect(html).toContain('data-agent-id="refresh"');
      expect(html).toContain('data-agent-id="xr-connect"');
    }
  });

  it("renders the empty / error states", () => {
    const empty = renderViewToLines(
      <FacewearSpatialView
        snapshot={{
          profiles: [],
          devices: [],
          connectedCount: 0,
          loading: false,
          error: "network down",
        }}
      />,
      50,
    ).join("\n");
    expect(empty).toContain("None");
    expect(empty).toContain("network down");
    expect(empty).toContain("None");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "facewear-spatial-test",
      () => view,
    );
    try {
      const component = getTerminalView("facewear-spatial-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
    } finally {
      unregister();
    }
  });
});
