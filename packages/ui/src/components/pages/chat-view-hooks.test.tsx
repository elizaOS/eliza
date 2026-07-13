// @vitest-environment jsdom

/**
 * jsdom `renderHook` tests for `useChatVoiceController` over a mocked
 * `useVoiceChat`: pins the audio-unlock ordering (speech queued by the same
 * gesture that unlocks audio is not cancelled) and message-play telemetry.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContinuousChat } from "../../hooks/useContinuousChat";
import { useRealtimeVoiceSession } from "../../hooks/useRealtimeVoiceSession";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import type { VoiceChatState } from "../../voice/voice-chat-types";
import {
  mapUiLanguageToSpeechLocale,
  useChatVoiceController,
  useGameModalMessages,
} from "./chat-view-hooks";

const realtimeHarness = vi.hoisted(() => ({
  state: {
    available: false,
    active: false,
    status: "idle" as const,
    transcriptPartial: "",
    transcriptFinal: "",
    agentSpeaking: false,
    paused: false,
    error: null,
    speaker: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    bargeIn: vi.fn(),
    unlock: vi.fn(async () => {}),
  },
}));

const continuousHarness = vi.hoisted(() => ({
  state: {
    enabled: false,
    setEnabled: vi.fn(),
    mode: "off",
    setMode: vi.fn(),
    status: "idle" as const,
    interimTranscript: "",
    latency: {},
    speaker: null,
    needsAudioUnlock: false,
    unlockAudio: vi.fn(),
    micReconnected: false,
    ttsError: null,
    resume: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
  },
}));

vi.mock("../../api/client", () => ({
  client: {
    getConfig: vi.fn(async () => ({})),
    updateConfig: vi.fn(async () => ({})),
  },
}));

vi.mock("../../hooks/useContinuousChat", () => ({
  DEFAULT_VOICE_CONTINUOUS_MODE: "off",
  useContinuousChat: vi.fn(() => continuousHarness.state),
}));

vi.mock("../../hooks/useRealtimeVoiceSession", () => ({
  VoiceSessionMintError: class VoiceSessionMintError extends Error {},
  isRealtimeVoiceFlagEnabled: vi.fn(() => true),
  useRealtimeVoiceSession: vi.fn(() => realtimeHarness.state),
}));

vi.mock("../../hooks/useDefaultProviderPresets", () => ({
  useDefaultProviderPresets: vi.fn(() => ({
    defaults: { asr: "local-inference", tts: "local-inference" },
  })),
}));

vi.mock("../../hooks/useDocumentVisibility", () => ({
  useDocumentVisibility: vi.fn(() => "visible"),
}));

vi.mock("../../hooks/useTimeout", () => ({
  useTimeout: vi.fn(() => ({ setTimeout: globalThis.setTimeout })),
}));

vi.mock("../../hooks/useVoiceChat", () => ({
  useVoiceChat: vi.fn(),
}));

const useVoiceChatMock = vi.mocked(useVoiceChat);
const useContinuousChatMock = vi.mocked(useContinuousChat);
const useRealtimeVoiceSessionMock = vi.mocked(useRealtimeVoiceSession);

function makeVoiceState(
  overrides: Partial<VoiceChatState> = {},
): VoiceChatState {
  return {
    assistantTtsQuality: "enhanced",
    captureMode: "idle",
    interimTranscript: "",
    isListening: false,
    isSpeaking: false,
    mouthOpen: 0,
    queueAssistantSpeech: vi.fn(),
    speak: vi.fn(),
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    supported: true,
    toggleListening: vi.fn(),
    usingAudioAnalysis: false,
    voiceUnlockedGeneration: 0,
    ...overrides,
  };
}

const baseOptions = {
  activeConversationId: "conversation-1",
  agentVoiceMuted: false,
  chatFirstTokenReceived: false,
  chatInput: "",
  chatSending: false,
  conversationMessages: [],
  elizaCloudConnected: false,
  elizaCloudHasPersistedKey: false,
  elizaCloudVoiceProxyAvailable: false,
  handleChatEdit: vi.fn(async () => true),
  handleChatSend: vi.fn(async () => {}),
  isComposerLocked: false,
  isGameModal: false,
  setState: vi.fn(),
  uiLanguage: "en",
};

describe("useChatVoiceController voice playback unlock", () => {
  let voiceState: VoiceChatState;

  beforeEach(() => {
    voiceState = makeVoiceState();
    useVoiceChatMock.mockImplementation(() => voiceState);
    realtimeHarness.state.available = false;
    realtimeHarness.state.active = false;
    realtimeHarness.state.status = "idle";
    realtimeHarness.state.error = null;
    realtimeHarness.state.start.mockClear();
    realtimeHarness.state.stop.mockClear();
    realtimeHarness.state.bargeIn.mockClear();
    continuousHarness.state.resume.mockClear();
    continuousHarness.state.pause.mockClear();
    useContinuousChatMock.mockClear();
    useRealtimeVoiceSessionMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not cancel speech queued by the same user gesture that unlocks audio", () => {
    const { rerender } = renderHook(() => useChatVoiceController(baseOptions));
    const stopSpeaking = vi.mocked(voiceState.stopSpeaking);

    voiceState = makeVoiceState({
      stopSpeaking,
      voiceUnlockedGeneration: 1,
    });

    act(() => {
      rerender();
    });

    expect(stopSpeaking).not.toHaveBeenCalled();
  });

  it("passes message telemetry through manual Play message speech", () => {
    const { result } = renderHook(() => useChatVoiceController(baseOptions));

    act(() => {
      result.current.handleSpeakMessage("message-1", "hello from Eliza");
    });

    expect(voiceState.speak).toHaveBeenCalledWith("hello from Eliza", {
      telemetry: { messageId: "message-1" },
    });
  });

  it("routes the primary mic to realtime when the force-armed session is available", () => {
    realtimeHarness.state.available = true;
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    act(() => {
      result.current.beginVoiceCapture("compose");
    });

    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).not.toHaveBeenCalled();
  });

  it("keeps batch passive capture disabled while realtime is armed for continuous mode", async () => {
    realtimeHarness.state.available = true;
    renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        continuousMode: "vad-gated",
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await waitFor(() =>
      expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1),
    );
    expect(useContinuousChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true, mode: "vad-gated" }),
    );
    expect(continuousHarness.state.resume).not.toHaveBeenCalled();
  });

  it("falls back to the batch path after realtime becomes unavailable", () => {
    realtimeHarness.state.available = true;
    const { rerender } = renderHook(
      (available: boolean) => {
        realtimeHarness.state.available = available;
        return useChatVoiceController({
          ...baseOptions,
          continuousMode: "vad-gated",
          realtimeAgentId: available
            ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
            : null,
          getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
        });
      },
      { initialProps: true },
    );

    expect(useContinuousChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true, mode: "vad-gated" }),
    );

    act(() => {
      rerender(false);
    });

    expect(useContinuousChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false, mode: "vad-gated" }),
    );
  });
});

describe("chat view locale and companion history", () => {
  const message = (id: string, timestamp: number) =>
    ({ id, timestamp, role: "assistant", text: id }) as never;

  it.each([
    ["zh-CN", "zh-CN"],
    ["ko", "ko-KR"],
    ["es", "es-ES"],
    ["pt", "pt-BR"],
    ["vi", "vi-VN"],
    ["tl", "fil-PH"],
    ["unknown", "en-US"],
  ])("maps %s to a supported speech locale", (input, expected) => {
    expect(mapUiLanguageToSpeechLocale(input)).toBe(expected);
  });

  it("keeps the two most recent messages when no cutoff messages exist", () => {
    const { result } = renderHook(() =>
      useGameModalMessages({
        activeConversationId: "conversation-1",
        companionMessageCutoffTs: 100,
        isGameModal: true,
        visibleMsgs: [
          message("one", 1),
          message("two", 2),
          message("three", 3),
        ],
      }),
    );
    expect(result.current.gameModalVisibleMsgs.map((item) => item.id)).toEqual([
      "two",
      "three",
    ]);
    expect(result.current.gameModalCarryoverOpacity).toBe(0);
  });

  it("carries prior messages when the companion cutoff advances", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00Z"));
    const messages = [message("old", 10), message("current", 20)];
    const { result, rerender } = renderHook(
      ({ cutoff }) =>
        useGameModalMessages({
          activeConversationId: "conversation-1",
          companionMessageCutoffTs: cutoff,
          isGameModal: true,
          visibleMsgs: messages,
        }),
      { initialProps: { cutoff: 0 } },
    );
    act(() => rerender({ cutoff: 15 }));
    expect(
      result.current.companionCarryover?.messages.map((item) => item.id),
    ).toEqual(["old"]);
    expect(result.current.gameModalVisibleMsgs.map((item) => item.id)).toEqual([
      "current",
    ]);
    vi.useRealTimers();
  });
});
