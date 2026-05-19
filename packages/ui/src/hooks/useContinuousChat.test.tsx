// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuousChatToggle } from "../components/composites/chat/ContinuousChatToggle";
import type {
  VoiceChatState,
  VoiceContinuousMode,
} from "../voice/voice-chat-types";
import { useContinuousChat } from "./useContinuousChat";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeVoiceState(
  overrides: Partial<VoiceChatState> = {},
): VoiceChatState {
  return {
    isListening: false,
    captureMode: "idle",
    isSpeaking: false,
    mouthOpen: 0,
    interimTranscript: "",
    supported: true,
    usingAudioAnalysis: false,
    toggleListening: vi.fn(),
    startListening: vi.fn().mockResolvedValue(undefined),
    stopListening: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn(),
    queueAssistantSpeech: vi.fn(),
    stopSpeaking: vi.fn(),
    voiceUnlockedGeneration: 0,
    assistantTtsQuality: "standard",
    ...overrides,
  };
}

interface HarnessProps {
  voice: VoiceChatState;
  disabled?: boolean;
  initialMode?: VoiceContinuousMode;
}

/**
 * Tiny harness that wires `ContinuousChatToggle` + `useContinuousChat` the
 * same way `useChatVoiceController` does. Lets the test drive the toggle and
 * assert that `voice.startListening("passive")` fires when the mode flips to
 * a non-off value.
 */
function ToggleHarness({ voice, disabled, initialMode = "off" }: HarnessProps) {
  const [mode, setMode] = useState<VoiceContinuousMode>(initialMode);
  useContinuousChat({
    voice,
    mode,
    disabled,
  });
  return (
    <ContinuousChatToggle
      value={mode}
      onChange={(next) => setMode(next)}
      disabled={disabled}
      data-testid="harness-toggle"
    />
  );
}

describe("ContinuousChatToggle + useContinuousChat integration", () => {
  it("invokes voice.startListening('passive') when the toggle enters always-on", async () => {
    const voice = makeVoiceState();
    render(<ToggleHarness voice={voice} />);

    const group = screen.getByTestId("harness-toggle");
    const alwaysOnButton = group.querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    expect(alwaysOnButton).toBeTruthy();

    await act(async () => {
      alwaysOnButton.click();
    });

    expect(voice.startListening).toHaveBeenCalledTimes(1);
    expect(voice.startListening).toHaveBeenCalledWith("passive");
  });

  it("calls voice.stopListening when the toggle returns to off", async () => {
    const voice = makeVoiceState({
      isListening: true,
      captureMode: "passive",
    });
    render(<ToggleHarness voice={voice} initialMode="always-on" />);

    const group = screen.getByTestId("harness-toggle");
    const offButton = group.querySelector(
      "button[data-mode='off']",
    ) as HTMLButtonElement;

    await act(async () => {
      offButton.click();
    });

    expect(voice.stopListening).toHaveBeenCalled();
  });

  it("does not bring up passive capture while disabled", async () => {
    const voice = makeVoiceState();
    render(<ToggleHarness voice={voice} disabled />);

    const group = screen.getByTestId("harness-toggle");
    const alwaysOnButton = group.querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    // The disabled toggle blocks the onChange callback so the mode never
    // moves off "off"; useContinuousChat never invokes startListening.
    await act(async () => {
      alwaysOnButton.click();
    });
    expect(voice.startListening).not.toHaveBeenCalled();
  });
});
