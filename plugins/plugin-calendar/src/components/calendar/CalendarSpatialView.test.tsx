/**
 * Tests that the spatial calendar surface renders to real terminal lines
 * through the `@elizaos/tui` registry, exercising the TUI modality of the
 * unified CalendarSpatialView with deterministic fixture events.
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
import {
  type CalendarSnapshot,
  CalendarSpatialView,
} from "./CalendarSpatialView.tsx";

const snapshot: CalendarSnapshot = {
  mode: "week",
  periodLabel: "June 2026",
  events: [
    {
      id: "e1",
      title: "Design sync",
      when: "9:00 AM - 10:00 AM",
      detail: "Room 4B",
      selected: true,
    },
    {
      id: "e2",
      title: "Lunch with Grace",
      when: "12:30 PM - 1:30 PM",
    },
    {
      id: "e3",
      title: "Quarterly review",
      when: "All day",
    },
  ],
};

const view = <CalendarSpatialView snapshot={snapshot} />;

describe("CalendarSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Design sync");
      expect(flat).toContain("Lunch with Grace");
      expect(flat).toContain("Today");
      expect(flat).toContain("New");
    }
  });

  it("TUI: at a comfortable width the full period label is visible", () => {
    const lines = renderViewToLines(view, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("June 2026");
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
      expect(html).toContain("Design sync");
      expect(html).toContain("Lunch with Grace");
      expect(html).toContain('data-agent-id="new"');
      expect(html).toContain('data-agent-id="prev"');
      expect(html).toContain('data-agent-id="today"');
      expect(html).toContain('data-agent-id="next"');
      expect(html).toContain('data-agent-id="select:e1"');
    }
  });

  it("empty agenda renders the no-events placeholder", () => {
    const empty: CalendarSnapshot = {
      mode: "day",
      periodLabel: "June 22, 2026",
      events: [],
    };
    const lines = renderViewToLines(
      <CalendarSpatialView snapshot={empty} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("None");
  });

  it("error state surfaces the error text", () => {
    const errored: CalendarSnapshot = {
      ...snapshot,
      error: "Calendar failed to load.",
    };
    const lines = renderViewToLines(
      <CalendarSpatialView snapshot={errored} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Calendar failed to load.");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("calendar-test", () => view);
    try {
      const component = getTerminalView("calendar-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Design sync");
    } finally {
      unregister();
    }
  });
});
