/**
 * Renders `GoalsSpatialView` through the TUI spatial registry to static markup
 * and asserts the terminal layout — deterministic, no live model or DB.
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
import type { GoalItem } from "../../types.ts";
import { type GoalsSnapshot, GoalsSpatialView } from "./GoalsSpatialView.tsx";

const goals: GoalItem[] = [
  {
    id: "g1",
    title: "Run 5k",
    description: "Couch to 5k plan",
    status: "active",
    reviewState: "at_risk",
    cadenceKind: "weekly",
    target: "May",
    linkedCount: 3,
    updatedAt: "2026-06-10T00:00:00.000Z",
  },
  {
    id: "g2",
    title: "Read more",
    description: "",
    status: "active",
    reviewState: "on_track",
    cadenceKind: null,
    target: null,
    linkedCount: 0,
    updatedAt: "2026-06-12T00:00:00.000Z",
  },
  {
    id: "g3",
    title: "Surf",
    description: "",
    status: "paused",
    reviewState: "idle",
    cadenceKind: null,
    target: null,
    linkedCount: 0,
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
];

const snapshot: GoalsSnapshot = {
  status: "ready",
  goals,
  activeStatuses: [],
};

const view = <GoalsSpatialView snapshot={snapshot} />;

describe("GoalsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Run 5k");
      expect(flat).toContain("Read more");
      expect(flat).toContain("Active");
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
      expect(html).toContain("Run 5k");
      expect(html).toContain("Read more");
      expect(html).toContain('data-agent-id="filter:active"');
      expect(html).toContain('data-agent-id="filter:paused"');
    }
  });

  it("loading state renders a loading line", () => {
    const loading: GoalsSnapshot = {
      status: "loading",
      goals: [],
      activeStatuses: [],
    };
    const lines = renderViewToLines(
      <GoalsSpatialView snapshot={loading} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading goals");
  });

  it("error state renders the message and a Retry action", () => {
    const error: GoalsSnapshot = {
      status: "error",
      goals: [],
      activeStatuses: [],
      error: "Goals request failed (503)",
    };
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <GoalsSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(gui).toContain("Could not load goals");
    expect(gui).toContain("Goals request failed (503)");
    expect(gui).toContain('data-agent-id="retry"');
  });

  it("empty (ready, no goals) renders the set-a-goal affordance", () => {
    const empty: GoalsSnapshot = {
      status: "ready",
      goals: [],
      activeStatuses: [],
    };
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <GoalsSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(gui).toContain("None");
    expect(gui).toContain('data-agent-id="new"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("goals-test", () => view);
    try {
      const component = getTerminalView("goals-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Run 5k");
    } finally {
      unregister();
    }
  });
});
