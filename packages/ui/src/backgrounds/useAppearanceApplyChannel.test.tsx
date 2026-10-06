/** Verifies useAppearanceApplyChannel through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * jsdom coverage for the chat-to-appearance view event bridge. The hook is
 * tested with the app store seeded directly so the test proves the event
 * contract reaches the same setters used by the Appearance settings section.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitViewEvent } from "../events/view-events";
import { UI_LANGUAGES } from "../i18n";
import { __setAppValueForTests } from "../state/app-store";
import { ACCENT_PRESETS } from "../state/ui-preferences";
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
  it("applies valid appearance fields to the persisted preference setters", () => {
    const setters = mountChannel();
    apply({
      accentId: "green",
      language: "es",
      homeTimeWidgetHidden: true,
    });

    expect(setters.setUiAccent).toHaveBeenCalledWith("green");
    expect(setters.setUiLanguage).toHaveBeenCalledWith("es");
    expect(setters.setHomeTimeWidgetHidden).toHaveBeenCalledWith(true);
  });

  it("ignores unrecognised accent and language tokens", () => {
    const setters = mountChannel();
    apply({
      accentId: "cyan",
      language: "fr",
      homeTimeWidgetHidden: "false",
    });

    expect(setters.setUiAccent).not.toHaveBeenCalled();
    expect(setters.setUiLanguage).not.toHaveBeenCalled();
    expect(setters.setHomeTimeWidgetHidden).not.toHaveBeenCalled();
  });

  it("applies a partial payload without touching unrelated setters", () => {
    const setters = mountChannel();
    apply({ accentId: "amber", unknownField: "ignored" });

    expect(setters.setUiAccent).toHaveBeenCalledTimes(1);
    expect(setters.setUiAccent).toHaveBeenCalledWith("amber");
    expect(setters.setUiLanguage).not.toHaveBeenCalled();
    expect(setters.setHomeTimeWidgetHidden).not.toHaveBeenCalled();
  });

  it("accepts false as a valid homeTimeWidgetHidden value", () => {
    const setters = mountChannel();
    apply({ homeTimeWidgetHidden: false });

    expect(setters.setHomeTimeWidgetHidden).toHaveBeenCalledTimes(1);
    expect(setters.setHomeTimeWidgetHidden).toHaveBeenCalledWith(false);
  });

  it("ignores non-string values for the semantic token fields", () => {
    const setters = mountChannel();
    apply({
      accentId: 7,
      language: { id: "es" },
    });

    expect(setters.setUiAccent).not.toHaveBeenCalled();
    expect(setters.setUiLanguage).not.toHaveBeenCalled();
  });

  it("accepts every configured accent preset id", () => {
    const setters = mountChannel();
    for (const preset of ACCENT_PRESETS) {
      apply({ accentId: preset.id });
    }

    expect(setters.setUiAccent).toHaveBeenCalledTimes(ACCENT_PRESETS.length);
    for (const [index, preset] of ACCENT_PRESETS.entries()) {
      expect(setters.setUiAccent).toHaveBeenNthCalledWith(index + 1, preset.id);
    }
  });

  it("accepts every configured UI language code", () => {
    const setters = mountChannel();
    for (const language of UI_LANGUAGES) {
      apply({ language });
    }

    expect(setters.setUiLanguage).toHaveBeenCalledTimes(UI_LANGUAGES.length);
    for (const [index, language] of UI_LANGUAGES.entries()) {
      expect(setters.setUiLanguage).toHaveBeenNthCalledWith(
        index + 1,
        language,
      );
    }
  });

  it("keeps applying events after the first one", () => {
    const setters = mountChannel();
    apply({ accentId: "green" });
    apply({ accentId: "amber" });

    expect(setters.setUiAccent).toHaveBeenCalledTimes(2);
    expect(setters.setUiAccent).toHaveBeenLastCalledWith("amber");
  });
});
