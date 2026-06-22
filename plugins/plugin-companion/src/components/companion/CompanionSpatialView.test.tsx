// @vitest-environment jsdom

import { visibleWidth } from "@elizaos/tui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_EMOTE_CATALOG, EMOTE_CATALOG } from "../../emotes/catalog";
import {
  type CompanionSnapshot,
  CompanionSpatialView,
} from "./CompanionSpatialView.tsx";
import { interact } from "./CompanionView.interact";

const eventDispatchers = vi.hoisted(() => ({
  dispatchAppEvent: vi.fn(),
  dispatchAppEmoteEvent: vi.fn(),
}));

vi.mock("@elizaos/ui/events", () => ({
  dispatchAppEvent: eventDispatchers.dispatchAppEvent,
  dispatchAppEmoteEvent: eventDispatchers.dispatchAppEmoteEvent,
  STOP_EMOTE_EVENT: "eliza:stop-emote",
}));

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

// Control affordances: clicking each agent button dispatches the matching action
// id through `onAction`. The host wires these to the companion app state
// (toggle-voice / new-chat / toggle-emotes / settings). Only Button/Field are
// DOM-clickable in spatial views, so these are the four operator controls.
describe("CompanionSpatialView controls dispatch onAction", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("wires each control button to its onAction id", () => {
    const onAction = vi.fn();
    render(
      <SpatialSurface modality="gui">
        <CompanionSpatialView snapshot={snapshot} onAction={onAction} />
      </SpatialSurface>,
    );

    // Default snapshot is voice-live, so the toggle reads "Mute".
    fireEvent.click(screen.getByText("Mute"));
    expect(onAction).toHaveBeenCalledWith("toggle-voice");

    fireEvent.click(screen.getByText("New chat"));
    expect(onAction).toHaveBeenCalledWith("new-chat");

    fireEvent.click(screen.getByText("Open emotes"));
    expect(onAction).toHaveBeenCalledWith("toggle-emotes");

    fireEvent.click(screen.getByText("Settings"));
    expect(onAction).toHaveBeenCalledWith("settings");

    // Snapshot has a playing emote, so the Stop control is present and wired.
    fireEvent.click(screen.getByText("Stop"));
    expect(onAction).toHaveBeenCalledWith("stop-emote");
  });

  it("reflects voice/emote-picker state in the control labels", () => {
    const onAction = vi.fn();
    render(
      <SpatialSurface modality="gui">
        <CompanionSpatialView
          snapshot={{
            ...snapshot,
            chatAgentVoiceMuted: true,
            emotePickerOpen: true,
            playingEmoteId: null,
          }}
          onAction={onAction}
        />
      </SpatialSurface>,
    );

    // Muted -> the voice toggle reads "Unmute".
    expect(screen.getByText("Unmute")).toBeTruthy();
    fireEvent.click(screen.getByText("Unmute"));
    expect(onAction).toHaveBeenCalledWith("toggle-voice");

    // Open picker -> the emote toggle reads "Close emotes".
    expect(screen.getByText("Close emotes")).toBeTruthy();
    expect(screen.queryByText("Open emotes")).toBeNull();

    // No playing emote -> no Stop control.
    expect(screen.queryByText("Stop")).toBeNull();
  });
});

// The view bundle's `interact` capability handler powers the terminal companion
// surface (state / emote listing / play / stop). It is independent of any React
// component and ships in the same bundle as CompanionView.
describe("companion view-bundle interact() capabilities", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("supports terminal capabilities for state, emotes, play, and stop", async () => {
    await expect(interact("terminal-companion-state")).resolves.toMatchObject({
      viewType: "tui",
      emoteCount: expect.any(Number),
      agentEmoteCount: expect.any(Number),
      capabilities: expect.arrayContaining(["terminal-companion-play-emote"]),
    });

    await expect(
      interact("terminal-companion-emotes", {
        category: "greeting",
        source: "agent",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      emotes: expect.arrayContaining([
        expect.objectContaining({ id: "wave", category: "greeting" }),
      ]),
    });

    await expect(
      interact("terminal-companion-play-emote", { emote: "wave" }),
    ).resolves.toEqual({ viewType: "tui", played: "wave" });
    expect(eventDispatchers.dispatchAppEmoteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ emoteId: "wave", showOverlay: true }),
    );

    await expect(interact("terminal-companion-stop-emote")).resolves.toEqual({
      viewType: "tui",
      stopped: true,
    });
    expect(eventDispatchers.dispatchAppEvent).toHaveBeenCalledWith(
      "eliza:stop-emote",
    );
  });

  it("rejects terminal-companion-play-emote for missing and unknown emotes", async () => {
    await expect(interact("terminal-companion-play-emote")).rejects.toThrow(
      "emote is required",
    );
    await expect(
      interact("terminal-companion-play-emote", { emote: "   " }),
    ).rejects.toThrow("emote is required");
    await expect(
      interact("terminal-companion-play-emote", { emote: "not-a-real-emote" }),
    ).rejects.toThrow("Unknown emote: not-a-real-emote");
    // No emote event is dispatched on the error paths.
    expect(eventDispatchers.dispatchAppEmoteEvent).not.toHaveBeenCalled();
  });

  it("returns the full catalog for terminal-companion-emotes with default source and no category", async () => {
    const all = (await interact("terminal-companion-emotes")) as {
      viewType: string;
      emotes: Array<{ id: string }>;
    };
    // Default source = "all" -> full EMOTE_CATALOG, no category filter.
    expect(all.viewType).toBe("tui");
    expect(all.emotes).toHaveLength(EMOTE_CATALOG.length);

    // source = "agent" returns the agent-allowed subset (excludes idle loop).
    const agent = (await interact("terminal-companion-emotes", {
      source: "agent",
    })) as { emotes: Array<{ id: string }> };
    expect(agent.emotes).toHaveLength(AGENT_EMOTE_CATALOG.length);
    expect(agent.emotes.length).toBeLessThan(all.emotes.length);
    expect(agent.emotes.some((e) => e.id === "idle")).toBe(false);

    // Each returned emote carries the contract fields the WS payload needs.
    const wave = all.emotes.find((e) => e.id === "wave") as
      | { id: string; path: string; duration: number; loop: boolean }
      | undefined;
    expect(wave).toBeDefined();
    expect(wave?.path.endsWith(".gz")).toBe(true);
    expect(typeof wave?.duration).toBe("number");
    expect(typeof wave?.loop).toBe("boolean");
  });

  it("rejects an unsupported capability", async () => {
    await expect(interact("terminal-companion-bogus")).rejects.toThrow(
      "Unsupported companion TUI capability: terminal-companion-bogus",
    );
  });
});
