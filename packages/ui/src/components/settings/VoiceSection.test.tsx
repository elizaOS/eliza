/** Verifies VoiceSection through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders the presentational VoiceSection with default prefs and asserts its
 * sub-panels mount and that the removed strategy/privacy controls stay absent.
 * jsdom, no backend.
 */

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
    expect(screen.getByTestId("voice-section-wake-toggle")).toBeTruthy();
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

  it("hides the entire models group for a Cloud-managed consumer build", () => {
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
        showModelsPanel={false}
      />,
    );
    expect(screen.queryByTestId("voice-section-models")).toBeNull();
    expect(
      screen.queryByText("Voice models appear here when available."),
    ).toBeNull();
  });

  it("toggles wake word through SettingsSwitchRow", () => {
    const onWakeWordToggle = vi.fn();
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={() => {}}
        wakeWordEnabled={false}
        onWakeWordToggle={onWakeWordToggle}
      />,
    );
    const wake = screen.getByTestId("voice-section-wake-toggle");
    expect(wake.getAttribute("role")).toBe("switch");
    expect(wake.getAttribute("data-agent-id")).toBe(
      "voice-section-wake-toggle",
    );
    expect(wake.getAttribute("aria-checked")).toBe("false");
    expect(wake.getAttribute("aria-label")).toBeNull();
    expect(screen.getByLabelText("Wake word")).toBe(wake);
    fireEvent.click(wake);
    expect(onWakeWordToggle).toHaveBeenCalledWith(true);
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

  it("renders shortcut auto-start off and propagates explicit consent", () => {
    const onPrefsChange = vi.fn();
    render(
      <VoiceSection
        {...baseProps}
        prefs={DEFAULT_VOICE_SECTION_PREFS}
        onPrefsChange={onPrefsChange}
      />,
    );
    const voice = screen.getByTestId("voice-section-intent-autostart-voice");
    const transcription = screen.getByTestId(
      "voice-section-intent-autostart-transcription",
    );
    expect(voice.getAttribute("role")).toBe("switch");
    expect(voice.getAttribute("aria-checked")).toBe("false");
    expect(transcription.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(voice);
    expect(onPrefsChange).toHaveBeenLastCalledWith({
      ...DEFAULT_VOICE_SECTION_PREFS,
      osIntentAutoStartVoice: true,
    });
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
