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
  DefenseAgentsSpatialView,
  type DefenseSnapshot,
} from "./DefenseAgentsSpatialView.tsx";

const snapshot: DefenseSnapshot = {
  status: "running",
  runId: "defense-run",
  canSendCommands: true,
  heroClass: "mage",
  heroLane: "mid",
  heroLevel: 3,
  heroHp: 80,
  heroMaxHp: 100,
  autoPlay: true,
  goalLabel: "Mage holding mid lane",
  suggestedPrompts: ["Move to top lane", "Recall to base", "Review strategy"],
  events: [
    {
      id: "e1",
      label: "command",
      message: "Holding mid lane",
      tone: "info",
    },
    {
      id: "e2",
      label: "respawn",
      message: "Hero respawned at base",
      tone: "warning",
    },
    {
      id: "e3",
      label: "error",
      message: "Rate limited",
      tone: "error",
    },
  ],
};

const view = <DefenseAgentsSpatialView snapshot={snapshot} />;

describe("DefenseAgentsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Defense of the Agents");
      expect(flat).toContain("Mage Lv3 mid, 80/100 HP");
      expect(flat).toContain("autoplay");
      expect(flat).toContain("Recall");
      expect(flat).toContain("mid"); // lane tab
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
      expect(html).toContain("Defense of the Agents");
      expect(html).toContain("Mage Lv3 mid, 80/100 HP");
      expect(html).toContain('data-agent-id="command-recall"');
      expect(html).toContain('data-agent-id="command-autoplay"');
      expect(html).toContain('data-agent-id="command-lane-mid"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "defense-of-the-agents-test",
      () => view,
    );
    try {
      const component = getTerminalView("defense-of-the-agents-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Defense of the Agents");
    } finally {
      unregister();
    }
  });
});
