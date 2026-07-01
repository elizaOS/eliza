// @vitest-environment jsdom

/**
 * Behavioral tests for the *mounted* Settings → Voice surface.
 *
 * `SettingsView` mounts `VoiceSectionMount` (see settings-sections.ts:
 * `voice.Component = VoiceSectionMount`), NOT the orphaned `VoiceConfigView`.
 * `VoiceSectionMount` is the real API/settings-store boundary: it loads prefs
 * from `client.getConfig()` and persists every change via
 * `client.updateConfig({ messages: { ...messages, voice: next } })`.
 *
 * The co-located `VoiceSection.test.tsx` already covers the presentational
 * child (continuous mode, auto-learn, privacy toggles, tier fallback, models
 * slot). It does NOT touch the persistence wiring or the wake-word prop
 * contract — that is the gap this file fills.
 *
 * Collaborators mocked: the `client` singleton (the transport boundary). The
 * unit under test (VoiceSectionMount + VoiceSection) is driven for real.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceSection } from "./VoiceSection";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getLocalInferenceDeviceTier: vi.fn(),
    // Real VoiceProfilesClient.list() hits this; keep it empty + successful.
    fetch: vi.fn(async () => ({ profiles: [] })),
  },
}));

vi.mock("../../api/client", () => ({ client: mockClient }));

// Imported after the mock so the module-load `createVoiceProfilesClient(client)`
// binds to the mocked transport.
import { VoiceSectionMount } from "./VoiceSectionMount";

/** A realistic server config with a sibling `messages.tts` block we must not clobber. */
function serverConfig(voice: Record<string, unknown>) {
  return {
    messages: {
      tts: { provider: "openai", voiceId: "alloy" },
      voice,
    },
  };
}

function resetClient() {
  mockClient.getConfig.mockReset();
  mockClient.updateConfig.mockReset();
  mockClient.getLocalInferenceDeviceTier.mockReset();
  mockClient.updateConfig.mockResolvedValue({ ok: true });
  mockClient.getLocalInferenceDeviceTier.mockResolvedValue({
    tier: "GOOD",
    reason: "test-tier",
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VoiceSectionMount — persistence boundary", () => {
  it("loads persisted prefs from the config store into the controls", async () => {
    resetClient();
    mockClient.getConfig.mockResolvedValue(
      serverConfig({
        continuous: "always-on",
        cloudFirstLineCache: true,
        autoLearnVoices: false,
      }),
    );

    render(<VoiceSectionMount />);

    // The controlled checkboxes must reflect the persisted server values, not
    // the built-in defaults (default cloudFirstLineCache=false, autoLearn=true).
    const cloud = (await screen.findByTestId(
      "voice-section-cloud-cache-toggle",
    )) as HTMLInputElement;
    const autoLearn = screen.getByTestId(
      "voice-section-auto-learn-toggle",
    ) as HTMLInputElement;

    await waitFor(() => expect(cloud.checked).toBe(true));
    expect(autoLearn.checked).toBe(false);
    expect(mockClient.getConfig).toHaveBeenCalled();
  });

  it("persists a toggle with the exact payload and preserves sibling messages keys", async () => {
    resetClient();
    mockClient.getConfig.mockResolvedValue(
      serverConfig({
        continuous: "always-on",
        cloudFirstLineCache: false,
        autoLearnVoices: true,
      }),
    );

    render(<VoiceSectionMount />);

    const cloud = (await screen.findByTestId(
      "voice-section-cloud-cache-toggle",
    )) as HTMLInputElement;
    await waitFor(() => expect(cloud.checked).toBe(false));

    fireEvent.click(cloud); // false -> true

    await waitFor(() => expect(mockClient.updateConfig).toHaveBeenCalledTimes(1));

    const payload = mockClient.updateConfig.mock.calls[0][0] as {
      messages: { tts?: unknown; voice: Record<string, unknown> };
    };
    // The changed field landed under messages.voice ...
    expect(payload.messages.voice.cloudFirstLineCache).toBe(true);
    // ... other voice prefs carried through unchanged ...
    expect(payload.messages.voice.continuous).toBe("always-on");
    expect(payload.messages.voice.autoLearnVoices).toBe(true);
    // ... and the unrelated sibling tts config was NOT dropped by the merge.
    expect(payload.messages.tts).toEqual({ provider: "openai", voiceId: "alloy" });
  });

  it("surfaces a persist-error alert when the store write rejects", async () => {
    resetClient();
    mockClient.getConfig.mockResolvedValue(
      serverConfig({ cloudFirstLineCache: false, autoLearnVoices: true }),
    );
    mockClient.updateConfig.mockRejectedValue(new Error("offline: 503"));

    render(<VoiceSectionMount />);

    const autoLearn = (await screen.findByTestId(
      "voice-section-auto-learn-toggle",
    )) as HTMLInputElement;
    await waitFor(() => expect(autoLearn.checked).toBe(true));

    fireEvent.click(autoLearn); // triggers a failing persist

    const alert = await screen.findByTestId("voice-section-persist-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("offline: 503");
  });

  it("rapid double-toggle stays idempotent — the last write matches the final UI state", async () => {
    resetClient();
    mockClient.getConfig.mockResolvedValue(
      serverConfig({ cloudFirstLineCache: true, autoLearnVoices: true }),
    );

    render(<VoiceSectionMount />);

    const cloud = (await screen.findByTestId(
      "voice-section-cloud-cache-toggle",
    )) as HTMLInputElement;
    await waitFor(() => expect(cloud.checked).toBe(true));

    fireEvent.click(cloud); // true  -> false
    fireEvent.click(cloud); // false -> true (back to start)

    await waitFor(() => expect(mockClient.updateConfig).toHaveBeenCalledTimes(2));

    // Each click persisted from the *current* state, so the final write returns
    // the value to its original — not a stale duplicate of the first write.
    const first = mockClient.updateConfig.mock.calls[0][0] as {
      messages: { voice: { cloudFirstLineCache: boolean } };
    };
    const last = mockClient.updateConfig.mock.calls[1][0] as {
      messages: { voice: { cloudFirstLineCache: boolean } };
    };
    expect(first.messages.voice.cloudFirstLineCache).toBe(false);
    expect(last.messages.voice.cloudFirstLineCache).toBe(true);
    // DOM converged to the final state.
    expect(cloud.checked).toBe(true);
  });

  it("gates malformed persisted prefs — invalid stored values fall back to defaults", async () => {
    resetClient();
    // Adversarial: wrong types for every field. readStoredVoicePrefs must
    // reject them rather than feed garbage into the controlled inputs.
    mockClient.getConfig.mockResolvedValue(
      serverConfig({
        continuous: 12345,
        cloudFirstLineCache: "yes",
        autoLearnVoices: null,
        vadAutoStop: "nope",
      }),
    );

    render(<VoiceSectionMount />);

    const cloud = (await screen.findByTestId(
      "voice-section-cloud-cache-toggle",
    )) as HTMLInputElement;
    const autoLearn = screen.getByTestId(
      "voice-section-auto-learn-toggle",
    ) as HTMLInputElement;

    // Defaults: cloudFirstLineCache=false, autoLearnVoices=true. Garbage that
    // slipped through would flip these (e.g. "yes" -> truthy checked). Settle on
    // the real loaded state, not a vacuous "the testid exists" wait.
    await waitFor(() => expect(cloud.checked).toBe(false));
    expect(autoLearn.checked).toBe(true);
    // Section still rendered — no crash on malformed vadAutoStop.
    expect(screen.getByTestId("voice-section")).toBeTruthy();
  });

  it("KNOWN-BUG tripwire: wake-word toggle does not persist (dead in Settings)", async () => {
    // KNOWN BUG (report §9a): VoiceSectionMount renders <VoiceSection> WITHOUT
    // onWakeWordToggle / wakeWordEnabled, so the wake-word checkbox is inert and
    // never reaches the config store — the setting cannot be changed from the UI.
    // This is a tripwire, NOT an assertion of correct behavior: when wake word is
    // wired to the master switch (voice/useWakeController) this test WILL fail,
    // forcing a deliberate update (and a look at the tracked gap).
    resetClient();
    mockClient.getConfig.mockResolvedValue(
      serverConfig({ cloudFirstLineCache: false, autoLearnVoices: true }),
    );

    render(<VoiceSectionMount />);

    const wake = (await screen.findByTestId(
      "voice-section-wake-toggle",
    )) as HTMLInputElement;
    fireEvent.click(wake);

    // Give any stray async persist a tick; none should fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockClient.updateConfig).not.toHaveBeenCalled();
  });
});

describe("VoiceSection — wake-word prop contract", () => {
  // The wake-word control's behavior lives on the VoiceSection prop contract,
  // which the existing VoiceSection.test.tsx does not exercise.
  function makeProfilesClient() {
    // Minimal stand-in; VoiceProfileSection only calls list() on mount here.
    return { list: async () => [] } as never;
  }

  const base = {
    tier: "GOOD" as const,
    profilesClient: makeProfilesClient(),
    prefs: {
      continuous: "off" as const,
      cloudFirstLineCache: false,
      autoLearnVoices: true,
    },
    onPrefsChange: () => {},
  };

  it("reflects wakeWordEnabled and fires onWakeWordToggle with the negated value", () => {
    const onWakeWordToggle = vi.fn();
    render(
      <VoiceSection
        {...base}
        wakeWordEnabled={true}
        onWakeWordToggle={onWakeWordToggle}
      />,
    );

    const wake = screen.getByTestId(
      "voice-section-wake-toggle",
    ) as HTMLInputElement;
    // DOM round-trips the prop.
    expect(wake.checked).toBe(true);
    // "On" label shown while enabled.
    expect(screen.getByTestId("voice-section-wake-row").textContent).toContain(
      "On",
    );

    fireEvent.click(wake); // unchecking
    expect(onWakeWordToggle).toHaveBeenCalledTimes(1);
    expect(onWakeWordToggle).toHaveBeenCalledWith(false);
  });

  it("renders wake word off and toggles it on when disabled", () => {
    const onWakeWordToggle = vi.fn();
    render(
      <VoiceSection
        {...base}
        wakeWordEnabled={false}
        onWakeWordToggle={onWakeWordToggle}
      />,
    );

    const wake = screen.getByTestId(
      "voice-section-wake-toggle",
    ) as HTMLInputElement;
    expect(wake.checked).toBe(false);
    expect(screen.getByTestId("voice-section-wake-row").textContent).toContain(
      "Off",
    );

    fireEvent.click(wake);
    expect(onWakeWordToggle).toHaveBeenCalledWith(true);
  });
});
