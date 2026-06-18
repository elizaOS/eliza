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
  makeHyperscapeRun,
  makeHyperscapeSession,
} from "../ui/test-support.js";
import {
  type HyperscapeSnapshot,
  HyperscapeSpatialView,
} from "./HyperscapeSpatialView.tsx";

const run = makeHyperscapeRun({
  session: makeHyperscapeSession({
    goalLabel: "Explore the northern district",
    suggestedPrompts: ["look around", "follow the merchant"],
    controls: ["pause"],
    activity: [
      {
        id: "act-1",
        type: "movement",
        message: "Walked to the plaza fountain",
        severity: "info",
      },
    ],
  }),
  recentEvents: [
    {
      eventId: "evt-1",
      kind: "launch",
      severity: "info",
      message: "Session launched",
      createdAt: "2026-05-19T00:00:00.000Z",
    },
  ],
});

const snapshot: HyperscapeSnapshot = { run };
const view = <HyperscapeSpatialView snapshot={snapshot} />;

describe("HyperscapeSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Hyperscape");
      expect(flat).toContain("running"); // run status
      expect(flat).toContain("Pause"); // control button
      expect(flat).toContain("look around"); // suggested prompt
      expect(flat).toContain("launch"); // recent event kind
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
      expect(html).toContain("Hyperscape");
      expect(html).toContain("look around");
      expect(html).toContain('data-agent-id="control-pause"');
    }
  });

  it("renders the empty-state panel when no run is resolved", () => {
    const emptyView = <HyperscapeSpatialView snapshot={{ run: null }} />;
    const lines = renderViewToLines(emptyView, 40);
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    const flat = lines.join("\n");
    expect(flat).toContain("No active Hyperscape run");
    expect(flat).toContain("Refresh");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "hyperscape-test",
      () => view,
    );
    try {
      const component = getTerminalView("hyperscape-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Hyperscape");
    } finally {
      unregister();
    }
  });
});
