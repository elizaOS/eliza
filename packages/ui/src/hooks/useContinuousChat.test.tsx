// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
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
    needsAudioUnlock: false,
    micReconnected: false,
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

  it("restores passive capture after an always-on turn completes", async () => {
    const voice = makeVoiceState({
      isListening: true,
      captureMode: "passive",
    });
    const { rerender } = render(
      <ToggleHarness voice={voice} initialMode="always-on" />,
    );

    expect(voice.startListening).not.toHaveBeenCalled();

    const completedTurnVoice = {
      ...voice,
      isListening: false,
      captureMode: "idle" as const,
    };
    rerender(
      <ToggleHarness voice={completedTurnVoice} initialMode="always-on" />,
    );

    expect(completedTurnVoice.startListening).toHaveBeenCalledWith("passive");
  });
});

describe("useContinuousChat thinking-timeout", () => {
  it("reports thinking while generating, then falls back after the timeout", () => {
    vi.useFakeTimers();
    try {
      const voice = makeVoiceState({
        isListening: true,
        captureMode: "passive",
      });
      const { result, rerender } = renderHook(
        ({ generating }: { generating: boolean }) =>
          useContinuousChat({
            voice,
            mode: "always-on",
            assistantGenerating: generating,
          }),
        { initialProps: { generating: false } },
      );

      // Generation starts → thinking.
      act(() => {
        rerender({ generating: true });
      });
      expect(result.current.status).toBe("thinking");

      // Generation never resolves; after the safety window the bar must not
      // stay pinned to thinking — it falls back to listening (passive mic open).
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(result.current.status).toBe("listening");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout latch when generation completes normally", () => {
    vi.useFakeTimers();
    try {
      const voice = makeVoiceState({
        isListening: true,
        captureMode: "passive",
      });
      const { result, rerender } = renderHook(
        ({ generating }: { generating: boolean }) =>
          useContinuousChat({
            voice,
            mode: "always-on",
            assistantGenerating: generating,
          }),
        { initialProps: { generating: true } },
      );
      expect(result.current.status).toBe("thinking");

      // Times out once.
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(result.current.status).toBe("listening");

      // Generation ends, then a fresh generation begins — thinking shows again
      // (the latch reset on the false transition).
      act(() => {
        rerender({ generating: false });
      });
      act(() => {
        rerender({ generating: true });
      });
      expect(result.current.status).toBe("thinking");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useContinuousChat interrupt indicator (UI-only, no server abort)", () => {
  // Regression guard for the codex P1: the listening-state transition drives
  // ONLY the UI interrupt pulse. It must NOT be used to abort the server turn,
  // because the hook itself reopens passive capture during TTS (mic rearm),
  // which would otherwise cut off ordinary assistant replies. The server abort
  // lives at the true speech-detected edge in useVoiceChat.
  it("pulses 'interrupting' when the mic reopens during TTS", () => {
    const { result, rerender } = renderHook(
      ({ voice }: { voice: VoiceChatState }) =>
        useContinuousChat({ voice, mode: "always-on" }),
      {
        initialProps: {
          voice: makeVoiceState({ isSpeaking: true, isListening: false }),
        },
      },
    );

    act(() => {
      rerender({
        voice: makeVoiceState({ isSpeaking: true, isListening: true }),
      });
    });

    expect(result.current.status).toBe("interrupting");
  });
});
