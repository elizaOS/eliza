import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ScapeSnapshot, ScapeSpatialView } from "./ScapeSpatialView.tsx";

const snapshot: ScapeSnapshot = {
  connectionStatus: "connected",
  pausedByOperator: false,
  operatorGoal: "train attack near the cows",
  canSend: true,
  activeGoal: {
    id: "goal-1",
    title: "Train attack on cows",
    status: "active",
    progress: 0.25,
    notes: "Stay in the Lumbridge cow field until level 10 attack.",
  },
  agent: {
    name: "LumbridgeRanger",
    combatLevel: 4,
    hp: 8,
    maxHp: 10,
    runEnergy: 91,
    inCombat: false,
    position: { x: 3225, z: 3265 },
    tick: 128,
  },
  skills: [
    { name: "Attack", level: 4, xp: 388 },
    { name: "Hitpoints", level: 10, xp: 1154 },
    { name: "Strength", level: 3, xp: 174 },
  ],
  inventory: [
    { itemId: 315, name: "Shrimps", count: 3, slot: 0 },
    { itemId: 1205, name: "Bronze dagger", count: 1, slot: 1 },
  ],
  nearbyNpcs: [
    { id: "npc-2000", name: "Cow", distance: "1 tile" },
    { id: "npc-2001", name: "Goblin", distance: "2 tiles" },
  ],
  nearbyPlayers: [{ id: "p-9001", name: "Zezima", distance: "5 tiles" }],
  nearbyItems: [{ id: "i-526", name: "Bones", distance: "2 tiles" }],
  memoryCount: 1,
  recentMemories: [
    {
      id: "mem-1",
      kind: "goal",
      text: "Spotted a cow nearby - beginning attack training.",
      weight: 4,
    },
  ],
  recentActions: [
    { id: "a-1", action: "walk_to", message: "moving to cows", success: true },
  ],
  suggestedPrompts: [
    "Walk to the Lumbridge cows and train attack.",
    "Pause and tell me what you see.",
  ],
};

const view = <ScapeSpatialView snapshot={snapshot} />;

describe("ScapeSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("'scape Operator");
      expect(flat).toContain("connected");
      expect(flat).toContain("LumbridgeRanger");
      expect(flat).toContain("Train attack on cows");
      expect(flat).toContain("Send command");
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
      expect(html).toContain("LumbridgeRanger");
      expect(html).toContain("connected");
      expect(html).toContain('data-agent-id="pause"');
      expect(html).toContain('data-agent-id="send"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("scape-test", () => view);
    try {
      const component = getTerminalView("scape-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("LumbridgeRanger");
    } finally {
      unregister();
    }
  });
});
