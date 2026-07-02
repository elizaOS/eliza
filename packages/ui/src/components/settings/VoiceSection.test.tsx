// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { VoiceSection, type VoiceSectionPrefs } from "./VoiceSection";
import { DEFAULT_VOICE_SECTION_PREFS } from "./VoiceSection.helpers";

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
  it("renders the sub-panels", () => {
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
    expect(screen.getByTestId("voice-section-models")).toBeTruthy();
    expect(screen.getByTestId("voice-profile-section")).toBeTruthy();
    // The local-vs-cloud strategy control was removed — per-modality routing
    // is owned by RoutingMatrix, not VoiceSection.
    expect(screen.queryByTestId("voice-section-strategy-select")).toBeNull();
  });

  it("no longer renders the dead privacy toggles (cloud cache / auto-learn)", () => {
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
      />,
    );
    // `messages.voice.{cloudFirstLineCache,autoLearnVoices}` have no readers;
    // the controls were removed so the UI stops offering no-op privacy opt-ins.
    expect(screen.queryByTestId("voice-section-privacy")).toBeNull();
    expect(screen.queryByTestId("voice-section-cloud-cache-toggle")).toBeNull();
    expect(screen.queryByTestId("voice-section-auto-learn-toggle")).toBeNull();
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
      .getByTestId("voice-section-continuous-row")
      .querySelector("button[data-mode='always-on']") as HTMLButtonElement;
    fireEvent.click(alwaysOn);
    expect(onPrefsChange).toHaveBeenCalledTimes(1);
    const call = onPrefsChange.mock.calls[0]?.[0] as VoiceSectionPrefs;
    expect(call.continuous).toBe("always-on");
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
