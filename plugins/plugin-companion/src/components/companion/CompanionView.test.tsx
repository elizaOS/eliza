// @vitest-environment jsdom

// Standard + XR companion view (componentExport `CompanionView`). The two
// registrations (`viewType: "gui"` and `viewType: "xr"`) render the IDENTICAL
// component — there is no xr-specific branch in the component — so a single
// render exercises both surfaces. The 3D scene host is mocked to a passthrough
// (three / @pixiv-three-vrm are peer deps and not asserted here); the emote
// picker overlay has its own dedicated test. This test asserts the overlay's
// data regions: the avatar-ready StatusChip and the emote-count chips, against
// the REAL catalog values (imported, never magic numbers) so the assertions
// track the catalog as it changes.

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_EMOTE_CATALOG, EMOTE_CATALOG } from "../../emotes/catalog";
import { countByCategory } from "./CompanionView.helpers";
import { CompanionSceneStatusContext } from "./companion-scene-status-context";

// useRenderGuard is the only @elizaos/ui hook the overlay itself calls; the
// vitest alias maps `@elizaos/ui` and `@elizaos/ui/hooks` to the same module
// id, so this mock covers the `/hooks` subpath import in CompanionView.
vi.mock("@elizaos/ui", () => ({
  useRenderGuard: vi.fn(),
}));

// The scene host is the VRM 3D stage. Mock it to a passthrough that also lets
// the test drive the avatar-ready context value consumed by StatusChip.
const sceneStatus = vi.hoisted(() => ({ avatarReady: false }));
vi.mock("./CompanionSceneHost", () => ({
  CompanionSceneHost: ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      CompanionSceneStatusContext.Provider,
      {
        value: { avatarReady: sceneStatus.avatarReady, teleportKey: "" },
      },
      children,
    ),
}));

// EmotePicker has its own dedicated test; here it is an inert placeholder so the
// overlay renders without pulling in the full picker tree.
vi.mock("./EmotePicker", () => ({
  EmotePicker: () =>
    React.createElement("div", { "data-testid": "emote-picker-stub" }),
}));

import { CompanionView } from "./CompanionView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sceneStatus.avatarReady = false;
});

const SUCCESS_BG = "var(--status-success-bg)";
const SUCCESS_FG = "var(--status-success)";
const ACCENT_BG = "var(--accent-subtle)";
const ACCENT_FG = "var(--accent)";

describe("CompanionView (standard/xr overlay chips)", () => {
  it("renders the avatar-ready StatusChip and emote-count chips with real catalog values when ready", () => {
    sceneStatus.avatarReady = true;
    const categoryCount = Object.keys(countByCategory()).length;

    render(React.createElement(CompanionView));

    // StatusChip: ready text + success colors, no pulse.
    const statusLabel = screen.getByText("ready");
    expect(statusLabel).toBeTruthy();
    // The dot + chip use the success theme tokens when ready.
    const statusChip = statusLabel.parentElement as HTMLElement;
    expect(statusChip.style.background).toBe(SUCCESS_BG);
    expect(statusChip.style.color).toBe(SUCCESS_FG);
    const dot = statusChip.querySelector("span") as HTMLElement;
    expect(dot.style.background).toBe(SUCCESS_FG);
    // No pulse animation when ready.
    expect(dot.style.animation === "" || dot.style.animation == null).toBe(
      true,
    );

    // "<AGENT_EMOTE_CATALOG.length> emotes" chip — tracks the real catalog.
    expect(AGENT_EMOTE_CATALOG.length).toBeGreaterThan(0);
    expect(
      screen.getByText(`${AGENT_EMOTE_CATALOG.length} emotes`),
    ).toBeTruthy();

    // "<EMOTE_CATALOG.length>/<categoryCount> catalog" chip.
    expect(EMOTE_CATALOG.length).toBeGreaterThan(0);
    expect(categoryCount).toBeGreaterThan(0);
    expect(
      screen.getByText(`${EMOTE_CATALOG.length}/${categoryCount} catalog`),
    ).toBeTruthy();

    // Static "overlay relay" chip.
    expect(screen.getByText("overlay relay")).toBeTruthy();

    // The agent emote count must be a strict subset of the full catalog (the
    // catalog includes the locomotion/idle loops the agent cannot trigger).
    expect(AGENT_EMOTE_CATALOG.length).toBeLessThanOrEqual(
      EMOTE_CATALOG.length,
    );
  });

  it("flips the StatusChip to loading (accent + pulse) when the avatar is not ready", () => {
    sceneStatus.avatarReady = false;

    render(React.createElement(CompanionView));

    const statusLabel = screen.getByText("loading");
    expect(statusLabel).toBeTruthy();
    expect(screen.queryByText("ready")).toBeNull();

    const statusChip = statusLabel.parentElement as HTMLElement;
    expect(statusChip.style.background).toBe(ACCENT_BG);
    expect(statusChip.style.color).toBe(ACCENT_FG);

    const dot = statusChip.querySelector("span") as HTMLElement;
    expect(dot.style.background).toBe(ACCENT_FG);
    // Pulse animation runs while loading.
    expect(dot.style.animation).toContain("companion-chip-pulse");

    // Emote count chips still render regardless of avatar-ready state.
    expect(
      screen.getByText(`${AGENT_EMOTE_CATALOG.length} emotes`),
    ).toBeTruthy();
  });
});
