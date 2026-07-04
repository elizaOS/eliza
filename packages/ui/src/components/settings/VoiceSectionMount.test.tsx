// @vitest-environment jsdom
/**
 * Mounts VoiceSectionMount (the fetch-and-persist wrapper around VoiceSection)
 * and asserts the wake-word toggle wiring, the continuous-chat localStorage
 * mirror, and that mount-time fetch failures fall back to default prefs.
 * jsdom, with an in-memory localStorage shim.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom in this env ships a localStorage whose methods can throw; back it with an
// in-memory Storage so the persisted wake-word pref actually round-trips.
{
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    } as Storage,
  });
}

const clientMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getLocalInferenceDeviceTier: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

// Voice profiles hit the network on mount; stub the sub-section since these
// tests are about the wake-word toggle wiring, not profiles.
vi.mock("./VoiceProfileSection", () => ({
  VoiceProfileSection: () => null,
}));

import {
  DEFAULT_VAD_AUTO_STOP_PREFS,
  DEFAULT_VOICE_SECTION_PREFS,
} from "./VoiceSection.helpers";
import { VoiceSectionMount } from "./VoiceSectionMount";

const WAKE_KEY = "eliza:voice:wake-word-enabled";

describe("VoiceSectionMount — wake-word toggle wiring (FIX 3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clientMock.getConfig.mockResolvedValue({});
    clientMock.updateConfig.mockResolvedValue({});
    clientMock.getLocalInferenceDeviceTier.mockResolvedValue({
      tier: "GOOD",
      reason: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults the wake-word toggle ON (no stored pref) and reflects it", async () => {
    render(<VoiceSectionMount />);
    const toggle = (await screen.findByTestId(
      "voice-section-wake-toggle",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // Let the mount-time async config/tier fetches settle to avoid act warnings.
    await waitFor(() =>
      expect(clientMock.getLocalInferenceDeviceTier).toHaveBeenCalled(),
    );
  });

  it("persists the toggle so the shell's wake pref maps to actual enablement", async () => {
    const user = userEvent.setup();
    render(<VoiceSectionMount />);
    const toggle = (await screen.findByTestId(
      "voice-section-wake-toggle",
    )) as HTMLInputElement;

    // Turning it off writes the persisted pref the shell reads for wake gating.
    await user.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(window.localStorage.getItem(WAKE_KEY)).toBe("false");

    // Turning it back on flips the pref again.
    await user.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(window.localStorage.getItem(WAKE_KEY)).toBe("true");
  });

  it("reflects a persisted wake-word-disabled pref on mount", async () => {
    window.localStorage.setItem(WAKE_KEY, "false");
    render(<VoiceSectionMount />);
    const toggle = (await screen.findByTestId(
      "voice-section-wake-toggle",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });
});

const CONTINUOUS_KEY = "eliza:voice:continuous-chat-mode";

describe("VoiceSectionMount — continuous-chat localStorage mirror", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clientMock.getConfig.mockResolvedValue({});
    clientMock.updateConfig.mockResolvedValue({});
    clientMock.getLocalInferenceDeviceTier.mockResolvedValue({
      tier: "GOOD",
      reason: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("mirrors a continuous-chat change into the localStorage key the chat surfaces read", async () => {
    const user = userEvent.setup();
    render(<VoiceSectionMount />);
    const row = await screen.findByTestId("voice-section-continuous-row");
    const alwaysOn = row.querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    expect(alwaysOn).toBeTruthy();

    await user.click(alwaysOn);

    // ChatView / useShellController implement continuous chat by reading
    // loadContinuousChatMode() (this key) — the server config alone is not
    // enough, so the control must mirror the store on every change.
    await waitFor(() =>
      expect(window.localStorage.getItem(CONTINUOUS_KEY)).toBe("always-on"),
    );
    // And the server config still gets the same value.
    await waitFor(() => expect(clientMock.updateConfig).toHaveBeenCalled());
    const payload = clientMock.updateConfig.mock.calls[0]?.[0] as {
      messages: { voice: { continuous: string } };
    };
    expect(payload.messages.voice.continuous).toBe("always-on");
  });

  it("seeds the localStorage mirror from the server config on load", async () => {
    clientMock.getConfig.mockResolvedValue({
      messages: { voice: { continuous: "vad-gated" } },
    });
    render(<VoiceSectionMount />);
    await waitFor(() =>
      expect(window.localStorage.getItem(CONTINUOUS_KEY)).toBe("vad-gated"),
    );
  });
});

const VAD_KEY = "eliza:voice:vad-auto-stop";

describe("VoiceSectionMount — mount fetch failures fall back to defaults (listener-safety batch)", () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    window.localStorage.clear();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
    clientMock.updateConfig.mockResolvedValue({});
    // Both mount-time fetches blow up: previously each ran in a bare void
    // async IIFE, so this surfaced as an unhandled rejection and left the
    // vadAutoStop / continuous-chat localStorage mirrors unseeded.
    clientMock.getConfig.mockRejectedValue(new Error("config fetch down"));
    clientMock.getLocalInferenceDeviceTier.mockRejectedValue(
      new Error("tier probe down"),
    );
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    cleanup();
  });

  it("renders defaults, seeds the local mirrors, and raises no unhandled rejection", async () => {
    render(<VoiceSectionMount />);

    // Defaults still render: the section is usable without the server.
    await screen.findByTestId("voice-section-wake-toggle");
    await screen.findByTestId("voice-section-continuous-row");
    expect(screen.queryByTestId("voice-section-persist-error")).toBeNull();

    // The capture hot path reads ONLY these localStorage mirrors, so a failed
    // config fetch must still seed them with the defaults.
    await waitFor(() => {
      expect(window.localStorage.getItem(CONTINUOUS_KEY)).toBe(
        DEFAULT_VOICE_SECTION_PREFS.continuous,
      );
      expect(
        JSON.parse(window.localStorage.getItem(VAD_KEY) ?? "null"),
      ).toEqual(DEFAULT_VAD_AUTO_STOP_PREFS);
    });

    // Let both rejected fetches fully settle, then confirm neither escaped as
    // an unhandled rejection.
    await waitFor(() =>
      expect(clientMock.getLocalInferenceDeviceTier).toHaveBeenCalled(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
  });
});
