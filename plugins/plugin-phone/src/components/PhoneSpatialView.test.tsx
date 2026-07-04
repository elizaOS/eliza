/**
 * Renders the presentational PhoneSpatialView through both the DOM (static
 * markup) and the terminal registry (real rendered lines), asserting the same
 * spatial component renders correctly across GUI and TUI surfaces.
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

  it("renders a distinct direction mark per call type (incoming/missed/outgoing)", () => {
    // Strip ANSI styling so the glyph-to-row binding is asserted on plain text
    // (ESC built via fromCharCode so no control char appears in the source).
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const flat = renderViewToLines(view, 54).join("\n").replace(ansi, "");
    // Each row carries its own direction glyph: incoming `<`, missed `x`,
    // outgoing `>` (the spatial-primitive stand-in for the lucide
    // phone-incoming/-missed/-outgoing icons of the retired overlay).
    expect(flat).toContain("< Ada Lovelace");
    expect(flat).toContain("x +15550200");
    expect(flat).toContain("> Grace Hopper");
  });

  it("renders the dialed number, an empty-recent fallback, and the error line", () => {
    const populated = renderViewToLines(view, 54).join("\n");
    expect(populated).toContain("Call"); // place-call control
    expect(populated).toContain("Contacts"); // contacts link

    const emptyErr = renderViewToLines(
      <PhoneSpatialView
        snapshot={{
          callReady: false,
          dialed: "",
          calls: [],
          error: "READ_CALL_LOG denied",
        }}
      />,
      54,
    ).join("\n");
    expect(emptyErr).toContain("call-blocked");
    expect(emptyErr).toContain("None");
    expect(emptyErr).toContain("READ_CALL_LOG denied");
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
