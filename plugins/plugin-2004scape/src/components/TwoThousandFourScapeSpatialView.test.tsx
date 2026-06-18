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
  type TwoThousandFourScapeSnapshot,
  TwoThousandFourScapeSpatialView,
} from "./TwoThousandFourScapeSpatialView.tsx";

const snapshot: TwoThousandFourScapeSnapshot = {
  hasRun: true,
  runId: "run-oakbot42",
  sessionId: "sess-oakbot42",
  status: "running",
  activeRunCount: 1,
  canSendCommands: true,
  autoPlayEnabled: true,
  intent: "tutorial",
  tutorialActive: true,
  tutorialPrompt: "Talk to the RuneScape Guide to begin.",
  player: { name: "oakbot42", worldX: 3222, worldZ: 3218, hp: 9, maxHp: 10 },
  weaponName: "Bronze axe",
  combatStyle: "Accurate",
  skillsSummary: "Woodcutting 5 - Hitpoints 10",
  inventorySummary: "Bronze axe - Logs x3",
  nearbyTargets: [
    {
      id: "npc-0-guide",
      name: "RuneScape Guide",
      distance: 1.4,
      action: "Talk-to",
    },
    { id: "loc-0-tree", name: "Tree", distance: 2.0, action: "Chop down" },
    { id: "npc-1-fish", name: "Fishing spot", distance: 4.2, action: "Net" },
  ],
  gameFeed: [
    { id: "msg-0", label: "Game", detail: "Welcome to 2004scape." },
    { id: "msg-1", label: "Game", detail: "You get some logs." },
  ],
  recentActivity: [
    {
      id: "act-0",
      action: "woodcut",
      detail: "Started chopping Tree.",
      when: "2m",
    },
    {
      id: "act-1",
      action: "login",
      detail: "Logging in as oakbot42.",
      when: "3m",
    },
  ],
  suggestedPrompts: ["Finish tutorial", "Talk to the RuneScape Guide"],
  controls: ["pause"],
};

const view = <TwoThousandFourScapeSpatialView snapshot={snapshot} />;

describe("TwoThousandFourScapeSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("2004scape");
      expect(flat).toContain("running");
      expect(flat).toContain("oakbot42");
      expect(flat).toContain("3222, 3218 - 9/10 HP");
      expect(flat).toContain("autoplay on");
      expect(flat).toContain("RuneScape Guide");
      expect(flat).toContain("Finish tutorial");
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
      expect(html).toContain("oakbot42");
      expect(html).toContain("RuneScape Guide");
      expect(html).toContain('data-agent-id="control-pause"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "2004scape-test",
      () => view,
    );
    try {
      const component = getTerminalView("2004scape-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("RuneScape Guide");
    } finally {
      unregister();
    }
  });
});
