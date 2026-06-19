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
  type LifeOpsSnapshot,
  LifeOpsSpatialView,
} from "./LifeOpsSpatialView.tsx";

const snapshot: LifeOpsSnapshot = {
  owner: {
    occurrences: [
      {
        id: "o1",
        title: "Reply to landlord",
        state: "visible",
        dueAt: "2h",
        priority: 80,
        subjectType: "owner",
      },
      {
        id: "o2",
        title: "Pay invoice 4821",
        state: "expired",
        dueAt: "1d",
        priority: 95,
        subjectType: "owner",
      },
    ],
    goals: [
      {
        id: "g1",
        title: "Ship Q3 launch",
        status: "active",
        subjectType: "owner",
        progress: 0.4,
      },
    ],
    reminders: [
      {
        id: "r1",
        title: "Standup",
        scheduledFor: "9m",
        channel: "push",
        urgency: "high",
        subjectType: "owner",
      },
    ],
    summary: "Two pending tasks and one launch goal in flight.",
  },
  agentOps: {
    occurrences: [
      {
        id: "a1",
        title: "Triage inbox",
        state: "scheduled",
        dueAt: "30m",
        priority: 50,
        subjectType: "agent",
      },
    ],
    goals: [],
    reminders: [],
    summary: "Inbox triage queued for the next run.",
  },
  schedule: {
    circadianState: "awake",
    relativeTime: "morning",
    sleepStatus: "slept",
    conflictCount: 2,
  },
};

const view = <LifeOpsSpatialView snapshot={snapshot} />;

describe("LifeOpsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("LifeOps");
      expect(flat).toContain("Reply to landlord");
      expect(flat).toContain("Ship Q3 launch");
      expect(flat).toContain("Triage inbox");
      expect(flat).toContain("Standup");
      expect(flat).toContain("awake");
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
      expect(html).toContain("Reply to landlord");
      expect(html).toContain("Ship Q3 launch");
      expect(html).toContain('data-agent-id="owner-occ-o1"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("lifeops-test", () => view);
    try {
      const component = getTerminalView("lifeops-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Reply to landlord");
    } finally {
      unregister();
    }
  });
});
