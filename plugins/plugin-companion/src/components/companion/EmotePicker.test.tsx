// @vitest-environment jsdom

// EmotePicker is the standard/xr companion view's only interactive surface (and
// is also opened from the TUI). This drives EVERY control: search filtering,
// category tab selection, the Stop + Close buttons, the playing/disabled state
// after an emote click, and the closed-state null render. The picker's emote
// grid is built from its own hardcoded ALL_EMOTES (see emote-picker-catalog
// contract test for the documented divergence from the runtime catalog).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  appState.emotePickerOpen = true;
  uiMocks.playEmote.mockResolvedValue({ ok: true });
});

describe("EmotePicker controls", () => {
  it("returns null when emotePickerOpen is false", () => {
    appState.emotePickerOpen = false;
    const { container } = render(<EmotePicker />);
    expect(container.querySelector('[data-testid="emote-picker"]')).toBeNull();
  });

  it("filters the grid by search text and shows the empty state for no matches", () => {
    render(<EmotePicker />);

    const search = screen.getByTestId(
      "emote-picker-search",
    ) as HTMLInputElement;

    // Typing "dance" narrows to the four dance items only.
    fireEvent.change(search, { target: { value: "dance" } });
    expect(screen.getByTestId("emote-picker-item-dance-happy")).toBeTruthy();
    expect(screen.getByTestId("emote-picker-item-dance-breaking")).toBeTruthy();
    expect(screen.getByTestId("emote-picker-item-dance-hiphop")).toBeTruthy();
    expect(screen.getByTestId("emote-picker-item-dance-popping")).toBeTruthy();
    // Non-matching items are gone.
    expect(screen.queryByTestId("emote-picker-item-wave")).toBeNull();
    expect(screen.queryByTestId("emote-picker-item-punching")).toBeNull();

    // Gibberish search -> empty state.
    fireEvent.change(search, { target: { value: "zzzznotanemote" } });
    expect(screen.queryByTestId("emote-picker-item-dance-happy")).toBeNull();
    expect(screen.getByText("emotepicker.NoEmotesFound")).toBeTruthy();
  });

  it("selects a category tab and shows only that category's emotes", () => {
    render(<EmotePicker />);

    // Click the "dance" category tab.
    const danceTab = screen.getByTestId("emote-picker-category-dance");
    fireEvent.click(danceTab);

    expect(danceTab.getAttribute("aria-current")).toBe("true");
    // Active tab uses the accent background.
    expect((danceTab as HTMLElement).style.background).toBe("var(--accent)");

    // Only dance items render; greeting/combat items are filtered out.
    expect(screen.getByTestId("emote-picker-item-dance-happy")).toBeTruthy();
    expect(screen.queryByTestId("emote-picker-item-wave")).toBeNull();
    expect(screen.queryByTestId("emote-picker-item-firing-gun")).toBeNull();

    // Clicking "all" resets the filter (wave reappears).
    const allTab = screen.getByTestId("emote-picker-category-all");
    fireEvent.click(allTab);
    expect(allTab.getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("emote-picker-item-wave")).toBeTruthy();
  });

  it("dispatches STOP_EMOTE_EVENT when the Stop button is clicked", () => {
    render(<EmotePicker />);
    fireEvent.click(screen.getByTestId("emote-picker-stop"));
    expect(uiMocks.dispatchAppEvent).toHaveBeenCalledWith(
      "eliza:test-stop-emote",
    );
  });

  it("calls closeEmotePicker when the Close button is clicked", () => {
    render(<EmotePicker />);
    fireEvent.click(screen.getByTestId("emote-picker-close"));
    expect(appState.closeEmotePicker).toHaveBeenCalledTimes(1);
  });

  it("plays an emote (client.playEmote) and disables the button while playing, re-enabling after the timeout", async () => {
    vi.useFakeTimers();
    render(<EmotePicker />);

    const waveButton = screen.getByTestId(
      "emote-picker-item-wave",
    ) as HTMLButtonElement;
    expect(waveButton.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(waveButton);
    });

    expect(uiMocks.playEmote).toHaveBeenCalledWith("wave");
    // The button is disabled immediately (playing state) before the 1s timeout.
    expect(
      (screen.getByTestId("emote-picker-item-wave") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Advance past the 1000ms reset window — button re-enables.
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(
      (screen.getByTestId("emote-picker-item-wave") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("toggles the picker closed on Escape", () => {
    render(<EmotePicker />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(appState.closeEmotePicker).toHaveBeenCalled();
  });
});
