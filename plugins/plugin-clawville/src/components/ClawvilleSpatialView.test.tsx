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
  type ClawvilleSnapshot,
  ClawvilleSpatialView,
} from "./ClawvilleSpatialView.tsx";

const snapshot: ClawvilleSnapshot = {
  runId: "clawville-run",
  status: "running",
  canSend: true,
  goalLabel: "Near Krusty Krab. Visit or ask the local NPC.",
  telemetry: { nearestBuildingLabel: "Krusty Krab", knowledgeCount: 2 },
  actions: [
    {
      id: "visit-nearest",
      label: "Visit nearest",
      command: "Visit the nearest building",
      testId: "clawville-command-visit-nearest",
    },
    {
      id: "ask-npc",
      label: "Ask NPC",
      command: "Ask the nearest NPC what to learn next",
      testId: "clawville-command-ask-npc",
    },
  ],
  events: [
    {
      id: "e1",
      label: "ClawVille",
      message: "Arrived at Krusty Krab.",
      tone: "success",
    },
    {
      id: "e2",
      label: "You",
      message: "Move to skill forge",
      tone: "user",
    },
  ],
};

const view = <ClawvilleSpatialView snapshot={snapshot} />;

describe("ClawvilleSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("ClawVille");
      expect(flat).toContain("live");
      expect(flat).toContain("Krusty Krab");
      expect(flat).toContain("Visit nearest");
      expect(flat).toContain("clawville-run");
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
      expect(html).toContain("ClawVille");
      expect(html).toContain("Krusty Krab");
      expect(html).toContain("Visit nearest");
      expect(html).toContain('data-agent-id="command-visit-nearest"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "clawville-test",
      () => view,
    );
    try {
      const component = getTerminalView("clawville-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Krusty Krab");
    } finally {
      unregister();
    }
  });
});
