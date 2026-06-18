import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type PhoneSnapshot, PhoneSpatialView } from "./PhoneSpatialView.tsx";

const snapshot: PhoneSnapshot = {
  callReady: true,
  dialed: "555-0100",
  calls: [
    {
      direction: "incoming",
      id: "c1",
      name: "Ada Lovelace",
      number: "+15550100",
      when: "2m",
    },
    {
      direction: "missed",
      id: "c2",
      name: "+15550200",
      number: "+15550200",
      when: "1h",
    },
    {
      direction: "outgoing",
      id: "c3",
      name: "Grace Hopper",
      number: "+15550300",
      when: "4h",
    },
  ],
};

const view = <PhoneSpatialView snapshot={snapshot} />;

describe("PhoneSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Phone");
      expect(flat).toContain("call-ready");
      expect(flat).toContain("Ada Lovelace");
      expect(flat).toContain("555-0100"); // dialed number
      expect(flat).toContain("Call");
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
      expect(html).toContain("Ada Lovelace");
      expect(html).toContain("call-ready");
      expect(html).toContain('data-agent-id="call"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("phone-test", () => view);
    try {
      const component = getTerminalView("phone-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Ada Lovelace");
    } finally {
      unregister();
    }
  });
});
