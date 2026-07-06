// @vitest-environment jsdom
/**
 * jsdom coverage for the chat-to-appearance view event bridge. The hook is
 * tested with the app store seeded directly so the test proves the event
 * contract reaches the same setters used by the Appearance settings section.
 */

import { APPEARANCE_APPLY_EVENT as SHARED_APPEARANCE_APPLY_EVENT } from "@elizaos/shared/events";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../state/app-store";
import { emitViewEvent } from "../views/view-event-bus";
import {
  APPEARANCE_APPLY_EVENT,
  useAppearanceApplyChannel,
} from "./useAppearanceApplyChannel";

function Channel(): null {
  useAppearanceApplyChannel();
  return null;
}

function mountChannel() {
  const setters = {
    setUiThemeMode: vi.fn(),
    setUiAccent: vi.fn(),
    setUiLanguage: vi.fn(),
    setHomeTimeWidgetHidden: vi.fn(),
  };
  __setAppValueForTests(setters as never);
  render(<Channel />);
  return setters;
}

function apply(payload: Record<string, unknown>): void {
  act(() => {
    emitViewEvent(APPEARANCE_APPLY_EVENT, payload, "agent");
  });
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("useAppearanceApplyChannel", () => {
  it("uses the shared appearance apply event contract", () => {
    expect(APPEARANCE_APPLY_EVENT).toBe(SHARED_APPEARANCE_APPLY_EVENT);
  });

  it("applies valid appearance fields to the persisted preference setters", () => {
    const setters = mountChannel();
    apply({
      themeMode: "dark",
      accentId: "green",
      language: "es",
      homeTimeWidgetHidden: true,
    });

    expect(setters.setUiThemeMode).toHaveBeenCalledWith("dark");
    expect(setters.setUiAccent).toHaveBeenCalledWith("green");
    expect(setters.setUiLanguage).toHaveBeenCalledWith("es");
    expect(setters.setHomeTimeWidgetHidden).toHaveBeenCalledWith(true);
  });

  it("ignores unrecognised theme, accent, and language tokens", () => {
    const setters = mountChannel();
    apply({
      themeMode: "sepia",
      accentId: "cyan",
      language: "fr",
      homeTimeWidgetHidden: "false",
    });

    expect(setters.setUiThemeMode).not.toHaveBeenCalled();
    expect(setters.setUiAccent).not.toHaveBeenCalled();
    expect(setters.setUiLanguage).not.toHaveBeenCalled();
    expect(setters.setHomeTimeWidgetHidden).not.toHaveBeenCalled();
  });
});
