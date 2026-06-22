import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FocusSnapshot, FocusSpatialView } from "./FocusSpatialView.tsx";

const activeSnapshot: FocusSnapshot = {
  phase: "active",
  startedAt: "10:00 AM",
  endsAt: "12:00 PM",
  matchMode: "subdomain",
  blockedWebsites: ["x.com", "reddit.com", "news.google.com"],
  canUnblockEarly: true,
  requiresElevation: false,
};

const view = <FocusSpatialView snapshot={activeSnapshot} />;

describe("FocusSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Focus");
      expect(flat).toContain("Focus session active");
      expect(flat).toContain("x.com");
      expect(flat).toContain("Match mode: subdomain");
      expect(flat).toContain("Release block");
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
      expect(html).toContain("Focus session active");
      expect(html).toContain("x.com");
      expect(html).toContain('data-agent-id="release"');
    }
  });

  it("error phase renders the message with a Retry action", () => {
    const error: FocusSnapshot = { phase: "error", error: "network down" };
    const lines = renderViewToLines(<FocusSpatialView snapshot={error} />, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("network down");
    expect(flat).toContain("Retry");

    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <FocusSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(gui).toContain('data-agent-id="retry"');
  });

  it("unavailable phase renders the platform + reason", () => {
    const unavailable: FocusSnapshot = {
      phase: "unavailable",
      platform: "linux",
      reason: "Could not find the system hosts file on this machine.",
    };
    const lines = renderViewToLines(
      <FocusSpatialView snapshot={unavailable} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Focus blocking is unavailable");
    expect(flat).toContain("linux");
    expect(flat).toContain("Could not find the system hosts file");
  });

  it("permission phase mentions the elevation method", () => {
    const permission: FocusSnapshot = {
      phase: "permission",
      elevationPromptMethod: "pkexec",
      reason: "Eliza needs administrator/root access.",
    };
    const lines = renderViewToLines(
      <FocusSpatialView snapshot={permission} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Permission needed");
    expect(flat).toContain("pkexec");
    expect(flat).toContain("enable website blocking");
  });

  it("empty phase renders the no-session prompt", () => {
    const empty: FocusSnapshot = { phase: "empty" };
    const lines = renderViewToLines(<FocusSpatialView snapshot={empty} />, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("No active focus session.");
    expect(flat).toContain("block distractions for 1 hour");
  });

  it("hides the Release control when the block cannot be released early", () => {
    const locked: FocusSnapshot = {
      phase: "active",
      startedAt: "10:00 AM",
      endsAt: null,
      matchMode: "exact",
      blockedWebsites: ["x.com"],
      canUnblockEarly: false,
      requiresElevation: true,
    };
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <FocusSpatialView snapshot={locked} />
      </SpatialSurface>,
    );
    expect(gui).not.toContain('data-agent-id="release"');
    expect(gui).toContain("Releasing this block needs administrator");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("focus-test", () => view);
    try {
      const component = getTerminalView("focus-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Focus session active");
    } finally {
      unregister();
    }
  });
});
