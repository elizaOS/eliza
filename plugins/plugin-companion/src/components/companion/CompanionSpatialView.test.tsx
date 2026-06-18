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
  type CompanionSnapshot,
  CompanionSpatialView,
} from "./CompanionSpatialView.tsx";

const snapshot: CompanionSnapshot = {
  avatarReady: true,
  selectedVrmIndex: 3,
  customVrmUrl: null,
  uiTheme: "dark",
  companionZoom: 1.25,
  dragOrbit: { yaw: 30, pitch: -10 },
  messageCount: 4,
  assistantCount: 2,
  userCount: 2,
  interruptedAssistantCount: 1,
  lastMessage: "hello there",
  lastUsageModel: "gpt-test",
  chatAgentVoiceMuted: false,
  emoteCount: 24,
  agentEmoteCount: 18,
  emotesByCategory: { greeting: 3, dance: 5, idle: 1 },
  emotePickerOpen: false,
  playingEmoteId: "wave",
  elizaCloudConnected: true,
  elizaCloudEnabled: true,
  elizaCloudAuthRejected: false,
  elizaCloudCreditsError: false,
  inferenceNoticeKind: "connected",
  uiLanguage: "en",
  tab: "companion",
  activeOverlayApp: "companion",
};

const view = <CompanionSpatialView snapshot={snapshot} />;

describe("CompanionSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Companion");
      expect(flat).toContain("avatar-ready");
      expect(flat).toContain("VRM #3");
      expect(flat).toContain("gpt-test"); // last model
      expect(flat).toContain("New chat");
      // "playing wave" may wrap across lines at narrow widths; assert tokens.
      expect(flat).toContain("playing");
      expect(flat).toContain("wave");
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
      expect(html).toContain("avatar-ready");
      expect(html).toContain("VRM #3");
      expect(html).toContain('data-agent-id="new-chat"');
      expect(html).toContain('data-agent-id="toggle-voice"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "companion-test",
      () => view,
    );
    try {
      const component = getTerminalView("companion-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Companion");
    } finally {
      unregister();
    }
  });
});
