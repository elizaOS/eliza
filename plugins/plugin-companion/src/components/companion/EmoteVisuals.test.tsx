// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  closeEmotePicker: vi.fn(),
  emotePickerOpen: true,
  openEmotePicker: vi.fn(),
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

const uiMocks = vi.hoisted(() => ({
  dispatchAppEvent: vi.fn(),
  playEmote: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  APP_EMOTE_EVENT: "eliza:test-app-emote",
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  client: {
    playEmote: uiMocks.playEmote,
  },
  dispatchAppEvent: uiMocks.dispatchAppEvent,
  EMOTE_PICKER_EVENT: "eliza:test-emote-picker",
  Input: React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => <input ref={ref} {...props} />),
  STOP_EMOTE_EVENT: "eliza:test-stop-emote",
  useApp: () => appState,
  useTimeout: () => ({ setTimeout: window.setTimeout.bind(window) }),
  Z_GLOBAL_EMOTE: 10,
  Z_SYSTEM_CRITICAL: 20,
}));

import { EmotePicker } from "./EmotePicker";
import { GlobalEmoteOverlay } from "./GlobalEmoteOverlay";

const rawEmoteGlyphs = /[\u{1F300}-\u{1FAFF}\u2694\u2728]/u;

describe("Companion emote visuals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.emotePickerOpen = true;
    uiMocks.playEmote.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the emote picker with icon components instead of raw emote glyphs", async () => {
    const { container } = render(<EmotePicker />);

    expect(screen.getByTestId("emote-picker")).toBeTruthy();
    expect(screen.getByTestId("emote-picker-category-greeting")).toBeTruthy();
    expect(screen.getByTestId("emote-picker-item-wave")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(8);
    expect(container.textContent ?? "").not.toMatch(rawEmoteGlyphs);

    fireEvent.click(screen.getByTestId("emote-picker-item-wave"));

    await waitFor(() => {
      expect(uiMocks.playEmote).toHaveBeenCalledWith("wave");
    });
  });

  it("renders global emote bursts as icon overlays instead of emoji text", async () => {
    const { container } = render(<GlobalEmoteOverlay />);

    fireEvent(
      window,
      new CustomEvent("eliza:test-app-emote", {
        detail: { emoteId: "dance-happy" },
      }),
    );

    const overlay = await screen.findByTestId("global-emote-overlay");
    expect(overlay.getAttribute("data-emote-id")).toBe("dance-happy");
    expect(overlay.textContent ?? "").not.toMatch(rawEmoteGlyphs);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
