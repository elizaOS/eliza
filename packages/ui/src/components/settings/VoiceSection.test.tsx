// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import {
  DEFAULT_VOICE_SECTION_PREFS,
  VoiceSection,
  type VoiceSectionPrefs,
} from "./VoiceSection";

afterEach(() => {
  cleanup();
});

function makeClient() {
  return new VoiceProfilesClient({
    fetch: async <T,>(): Promise<T> => ({ profiles: [] }) as T,
  });
}

const baseProps = {
  tier: "GOOD" as const,
  profilesClient: makeClient(),
};

describe("VoiceSection", () => {
  it("renders all six sub-panels", () => {
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
      />,
    );
    expect(screen.getByTestId("voice-section")).toBeTruthy();
    expect(screen.getByTestId("voice-tier-banner")).toBeTruthy();
    expect(screen.getByTestId("voice-section-continuous-row")).toBeTruthy();
    expect(screen.getByTestId("voice-section-wake-row")).toBeTruthy();
    expect(screen.getByTestId("voice-section-strategy-select")).toBeTruthy();
    expect(screen.getByTestId("voice-section-models")).toBeTruthy();
    expect(screen.getByTestId("voice-profile-section")).toBeTruthy();
    expect(screen.getByTestId("voice-section-privacy")).toBeTruthy();
  });

  it("renders the models slot when supplied", () => {
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
        modelsPanel={<div data-testid="i5-model-updates-panel">I5</div>}
      />,
    );
    expect(screen.getByTestId("i5-model-updates-panel")).toBeTruthy();
    expect(screen.queryByTestId("voice-section-models-empty")).toBeNull();
  });

  it("renders the empty placeholder when no models panel is supplied", () => {
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
      />,
    );
    expect(screen.getByTestId("voice-section-models-empty")).toBeTruthy();
  });

  it("propagates continuous-mode changes", () => {
    const onPrefsChange = vi.fn();
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={onPrefsChange}
      />,
    );
    const alwaysOn = screen
      .getByRole("radiogroup")
      .querySelector("button[data-mode='always-on']") as HTMLButtonElement;
    fireEvent.click(alwaysOn);
    expect(onPrefsChange).toHaveBeenCalledTimes(1);
    const call = onPrefsChange.mock.calls[0]?.[0] as VoiceSectionPrefs;
    expect(call.continuous).toBe("always-on");
  });

  it("propagates strategy changes", () => {
    const onPrefsChange = vi.fn();
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={onPrefsChange}
      />,
    );
    const select = screen.getByTestId(
      "voice-section-strategy-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "force-cloud" } });
    expect(onPrefsChange).toHaveBeenCalled();
    const call = onPrefsChange.mock.calls[0]?.[0] as VoiceSectionPrefs;
    expect(call.strategy).toBe("force-cloud");
  });

  it("toggles the privacy switches", () => {
    const onPrefsChange = vi.fn();
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={onPrefsChange}
      />,
    );
    const cloudToggle = screen.getByTestId(
      "voice-section-cloud-cache-toggle",
    ) as HTMLInputElement;
    expect(cloudToggle.checked).toBe(false);
    fireEvent.click(cloudToggle);
    const call = onPrefsChange.mock.calls[0]?.[0] as VoiceSectionPrefs;
    expect(call.cloudFirstLineCache).toBe(true);
  });

  it("falls back to GOOD tier when null is supplied", () => {
    render(
      <VoiceSection
        {...baseProps}
        tier={null}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId("voice-tier-banner").getAttribute("data-tier"),
    ).toBe("GOOD");
  });
});
