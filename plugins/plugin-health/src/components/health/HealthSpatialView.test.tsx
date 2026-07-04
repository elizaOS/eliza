/**
 * Renders HealthSpatialView through the TUI terminal registry and asserts the
 * owner sleep summary rasterizes to real terminal lines. Deterministic, no live data.
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
  EMPTY_HEALTH_SNAPSHOT,
  type HealthSnapshot,
  HealthSpatialView,
} from "./HealthSpatialView.tsx";

const ready: HealthSnapshot = {
  state: "ready",
  windowDays: 14,
  proactive: "Sleep was irregular this window — bedtime and wake times varied.",
  lastSleep: [
    { label: "Duration", value: "7h 45m" },
    { label: "Type", value: "overnight" },
    { label: "Confidence", value: "92%" },
  ],
  regularity: [
    { label: "Classification", value: "Regular" },
    { label: "SRI", value: "78" },
  ],
  baseline: [
    { label: "Typical bedtime", value: "23:30" },
    { label: "Typical wake", value: "07:15" },
  ],
  windowSummary: [
    { label: "Nights recorded", value: "6" },
    { label: "Average duration", value: "7h 32m" },
  ],
  emptyDetail: "",
};

const view = <HealthSpatialView snapshot={ready} />;

describe("HealthSpatialView one source, three modalities", () => {
  it("TUI: frames cleanly at the gate widths (56 + 40) with long content", () => {
    const long: HealthSnapshot = {
      ...ready,
      windowDays: 30,
      proactive:
        "Sleep was very irregular this window — bedtime and wake times drifted a lot.",
      lastSleep: [
        { label: "Duration", value: "7h 45m" },
        { label: "Bedtime", value: "6/16/2026, 11:30:00 PM" },
        { label: "Wake", value: "6/17/2026, 7:15:00 AM" },
        { label: "Source", value: "health" },
      ],
    };
    for (const width of [56, 40]) {
      const lines = renderViewToLines(
        <HealthSpatialView snapshot={long} />,
        width,
      );
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Last sleep");
      expect(flat).toContain("Regularity");
      expect(flat).toContain("Baseline");
      expect(flat).toContain("Window summary");
      expect(flat).toContain("7h 45m");
      expect(flat).toContain("Regular");
      expect(flat).toContain("23:30");
      expect(flat).toContain("irregular");
    }
  });

  it("GUI + XR: renders DOM with the surface marker and summary content, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("7h 45m");
      expect(html).toContain("23:30");
      expect(html).toContain('data-agent-id="row-Duration"');
      expect(html).toContain('data-agent-id="row-SRI"');
    }
  });

  it("renders the window-range control with the active window selected", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="window-7"');
    expect(html).toContain('data-agent-id="window-14"');
    expect(html).toContain('data-agent-id="window-30"');
    expect(html).toContain("7d");
    expect(html).toContain("14d");
    expect(html).toContain("30d");
  });

  it("loading state renders a quiet loading line", () => {
    const lines = renderViewToLines(
      <HealthSpatialView snapshot={EMPTY_HEALTH_SNAPSHOT} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading");
  });

  it("empty state renders the connect-a-source body", () => {
    const empty: HealthSnapshot = {
      ...EMPTY_HEALTH_SNAPSHOT,
      state: "empty",
      emptyDetail: "Nothing was recorded in the last 14 days.",
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <HealthSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
    expect(html).not.toContain("Nothing was recorded in the last 14 days.");
  });

  it("error state renders the message and a Retry control", () => {
    const error: HealthSnapshot = {
      ...EMPTY_HEALTH_SNAPSHOT,
      state: "error",
      error: "boom",
    };
    const lines = renderViewToLines(<HealthSpatialView snapshot={error} />, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("boom");
    expect(flat).toContain("Retry");

    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <HealthSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="retry"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("health-test", () => view);
    try {
      const component = getTerminalView("health-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("7h 45m");
    } finally {
      unregister();
    }
  });
});
