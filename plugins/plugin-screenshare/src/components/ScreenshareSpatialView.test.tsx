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
  type ScreenshareSnapshot,
  ScreenshareSpatialView,
} from "./ScreenshareSpatialView.tsx";

const snapshot: ScreenshareSnapshot = {
  platform: "darwin",
  session: {
    id: "sess-abc123",
    label: "This machine",
    status: "active",
    platform: "darwin",
    frameCount: 42,
    inputCount: 7,
    lastFrameAt: "10:42:01",
    lastInputAt: "10:41:58",
  },
  capabilities: [
    { name: "headfulGui", available: true, tool: "swaymsg" },
    { name: "screenshot", available: true, tool: "scrot" },
    { name: "computerUse", available: false, tool: "xdotool" },
  ],
  host: {
    token: "tok-7f3",
    sessionId: "sess-abc123",
    baseUrl: "http://localhost:31337",
  },
  remote: {
    token: "rmt-9q1",
    sessionId: "remote-xyz",
    baseUrl: "http://remote.example",
  },
};

const view = <ScreenshareSpatialView snapshot={snapshot} />;

describe("ScreenshareSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Screen Share");
      expect(flat).toContain("active");
      expect(flat).toContain("This machine");
      expect(flat).toContain("headfulGui");
      expect(flat).toContain("Rotate");
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
      expect(html).toContain("This machine");
      expect(html).toContain("headfulGui");
      expect(html).toContain('data-agent-id="start"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "screenshare-test",
      () => view,
    );
    try {
      const component = getTerminalView("screenshare-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("This machine");
    } finally {
      unregister();
    }
  });
});
