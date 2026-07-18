// @vitest-environment jsdom

/**
 * jsdom `renderHook` tests for `useChatVoiceController` over a mocked
 * `useVoiceChat`: pins the audio-unlock ordering (speech queued by the same
 * gesture that unlocks audio is not cancelled) and message-play telemetry.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { useContinuousChat } from "../../hooks/useContinuousChat";
import {
  type RealtimeVoiceError,
  type RealtimeVoiceStartOutcome,
  type UseRealtimeVoiceSessionState,
  useRealtimeVoiceSession,
} from "../../hooks/useRealtimeVoiceSession";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import {
  getVoiceCaptureBreadcrumbs,
  resetVoiceCaptureBreadcrumbs,
} from "../../utils/voice-capture-debug";
import type { VoiceChatState } from "../../voice/voice-chat-types";
import { ChatComposer } from "../composites/chat/chat-composer";
import {
  mapUiLanguageToSpeechLocale,
  useChatVoiceController,
  useGameModalMessages,
} from "./chat-view-hooks";

type RealtimeHarnessState = Omit<
  UseRealtimeVoiceSessionState,
  "start" | "stop" | "bargeIn" | "unlock"
> & {
  start: ReturnType<typeof vi.fn<() => Promise<RealtimeVoiceStartOutcome>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  bargeIn: ReturnType<typeof vi.fn<() => void>>;
  unlock: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const realtimeHarness = vi.hoisted(() => {
  const state: RealtimeHarnessState = {
    available: false,
    active: false,
    connecting: false,
    status: "idle" as const,
    transcriptPartial: "",
    transcriptFinal: "",
    agentSpeaking: false,
    needsUnlock: false,
    paused: false,
    error: null as RealtimeVoiceError | null,
    speaker: null,
    start: vi.fn<() => Promise<RealtimeVoiceStartOutcome>>(async () => ({
      kind: "live",
    })),
    stop: vi.fn(async () => {}),
    bargeIn: vi.fn(),
    unlock: vi.fn(async () => {}),
  };
  return { state };
});

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
    realtimeHarness.state.connecting = false;
    realtimeHarness.state.status = "idle";
    realtimeHarness.state.agentSpeaking = false;
    realtimeHarness.state.needsUnlock = false;
    realtimeHarness.state.error = null;
    realtimeHarness.state.start.mockReset();
    realtimeHarness.state.start.mockResolvedValue({ kind: "live" });
    realtimeHarness.state.stop.mockClear();
    realtimeHarness.state.bargeIn.mockClear();
    continuousHarness.state.resume.mockClear();
    continuousHarness.state.pause.mockClear();
    useContinuousChatMock.mockClear();
    useRealtimeVoiceSessionMock.mockClear();
    useRealtimeVoiceSessionMock.mockImplementation(() => realtimeHarness.state);
  });

  afterEach(() => {
    cleanup();
    resetVoiceCaptureBreadcrumbs();
    vi.useRealTimers();
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

  it("retries realtime on the next mic tap after an ACTIONABLE error (the advertised retry works)", async () => {
    realtimeHarness.state.available = true;
    realtimeHarness.state.error = {
      kind: "transport" as const,
      message: "Voice connection dropped. Tap the mic to try again.",
      actionable: true,
    };
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
    });

    // The tap re-enters the realtime branch (start() clears the error) rather
    // than silently switching to batch while the CTA says "try again".
    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).not.toHaveBeenCalled();
  });

  it("hands the mic tap to batch after a NON-actionable error (copy promises standard voice)", async () => {
    realtimeHarness.state.available = true;
    realtimeHarness.state.error = {
      kind: "consent" as const,
      message:
        "Couldn't confirm consent for realtime voice. The mic will use standard voice instead.",
      actionable: false,
    };
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
    });

    expect(realtimeHarness.state.start).not.toHaveBeenCalled();
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
  });

  it("routes the primary mic to realtime when the force-armed session is available", async () => {
    realtimeHarness.state.available = true;
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
    });

    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).not.toHaveBeenCalled();
  });

  it.each([
    ["consent failure", "consent" as const],
    ["mint 404/failure", "mint" as const],
    ["pre-ready WS failure", "transport" as const],
  ])("falls back to batch on the same mic tap after %s", async (_label, reason) => {
    realtimeHarness.state.available = true;
    realtimeHarness.state.start.mockResolvedValueOnce({
      kind: "fallback-to-batch",
      reason,
    });
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
  });

  it("starts batch directly when realtime eligibility is off", async () => {
    realtimeHarness.state.available = false;
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: null,
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
    });

    expect(realtimeHarness.state.start).not.toHaveBeenCalled();
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to batch after realtime has owned the mic", async () => {
    realtimeHarness.state.available = true;
    realtimeHarness.state.active = true;
    realtimeHarness.state.error = {
      kind: "transport" as const,
      message: "Voice connection dropped. Tap the mic to try again.",
      actionable: true,
    };
    const { result } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).not.toHaveBeenCalled();
  });

  it("keeps a normal realtime mic-tap session alive while continuous mode is off", async () => {
    realtimeHarness.state.available = true;
    const { result, rerender } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        continuousMode: "off",
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    await act(async () => {
      result.current.beginVoiceCapture("compose");
      await Promise.resolve();
    });
    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);

    realtimeHarness.state.active = true;
    act(() => rerender());
    await waitFor(() =>
      expect(realtimeHarness.state.stop).not.toHaveBeenCalled(),
    );

    act(() => result.current.endVoiceCapture());
    expect(realtimeHarness.state.stop).toHaveBeenCalledTimes(1);
  });

  it("a second real composer click cancels a deferred realtime start", async () => {
    realtimeHarness.state.available = true;
    realtimeHarness.state.active = false;
    realtimeHarness.state.start.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    voiceState = makeVoiceState({ supported: true });

    function ComposerHarness() {
      const controller = useChatVoiceController({
        ...baseOptions,
        continuousMode: "off",
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "deferred-consent"),
      });
      return (
        <ChatComposer
          variant="default"
          layout="inline"
          textareaRef={createRef<HTMLTextAreaElement>()}
          chatInput=""
          chatPendingImagesCount={0}
          isComposerLocked={false}
          isAgentStarting={false}
          chatSending={false}
          hideAttachButton
          voice={{
            supported: controller.voice.supported,
            isListening: controller.composerVoice.isListening,
            captureMode: controller.composerVoice.captureMode,
            interimTranscript: controller.composerVoice.interimTranscript,
            isSpeaking: controller.voice.isSpeaking,
            startListening: controller.beginVoiceCapture,
            stopListening: controller.endVoiceCapture,
          }}
          agentVoiceEnabled={false}
          t={(key) => key}
          onAttachImage={() => {}}
          onChatInputChange={() => {}}
          onSend={() => {}}
          onStop={() => {}}
          onStopSpeaking={() => {}}
          onToggleAgentVoice={() => {}}
        />
      );
    }

    const { getByTestId } = render(<ComposerHarness />);
    const mic = getByTestId("chat-composer-mic");
    fireEvent.click(mic);
    await waitFor(() => {
      expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
      expect(mic.getAttribute("aria-pressed")).toBe("true");
    });

    fireEvent.click(mic);
    await waitFor(() => {
      expect(realtimeHarness.state.stop).toHaveBeenCalledTimes(1);
      expect(mic.getAttribute("aria-pressed")).toBe("false");
    });
    expect(realtimeHarness.state.start).toHaveBeenCalledTimes(1);
    expect(voiceState.startListening).not.toHaveBeenCalled();
  });

  it("wires mint and trace correlation into privacy-safe client telemetry", () => {
    realtimeHarness.state.available = true;
    renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    const hookOptions = useRealtimeVoiceSessionMock.mock.calls.at(-1)?.[0];
    if (!hookOptions) throw new Error("realtime hook was not configured");
    act(() => {
      hookOptions.onMinted?.({
        sessionId: "session-safe-id",
        wsUrl: "wss://voice.test/ws",
        token: "must-not-be-recorded",
        expiresAt: 1,
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
      });
      hookOptions.clientOptions?.onTraceMark?.({
        name: "speaking_start",
        traceId: "trace-safe-id",
        atMs: 42,
      });
    });

    const breadcrumbs = getVoiceCaptureBreadcrumbs();
    expect(breadcrumbs.map((entry) => entry.step)).toEqual([
      "realtime:mint",
      "realtime:trace",
    ]);
    expect(breadcrumbs[0]?.detail).toEqual({ correlated: true });
    expect(breadcrumbs[1]?.detail).toEqual({
      name: "speaking_start",
      atMs: 42,
      hasSessionId: true,
      hasTraceId: true,
    });
    expect(JSON.stringify(breadcrumbs)).not.toContain("session-safe-id");
    expect(JSON.stringify(breadcrumbs)).not.toContain("trace-safe-id");
    expect(JSON.stringify(breadcrumbs)).not.toContain("must-not-be-recorded");
  });

  it("exposes realtime mic ownership to the composer while preserving speaking barge-in", async () => {
    useRealtimeVoiceSessionMock.mockImplementation(() => ({
      ...realtimeHarness.state,
    }));
    realtimeHarness.state.available = true;
    realtimeHarness.state.active = true;
    const { result, rerender } = renderHook(() =>
      useChatVoiceController({
        ...baseOptions,
        continuousMode: "vad-gated",
        realtimeAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        getRealtimeConsentNonce: vi.fn(async () => "nonce-1"),
      }),
    );

    expect(result.current.composerVoice).toMatchObject({
      isListening: true,
      captureMode: "compose",
    });

    realtimeHarness.state.agentSpeaking = true;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(result.current.composerVoice.isListening).toBe(false);
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

describe("chat-view hook helpers", () => {
  const message = (id: string, timestamp: number): ConversationMessage => ({
    id,
    role: "assistant",
    text: id,
    timestamp,
  });

  it("maps every supported UI language to its speech locale", () => {
    expect(mapUiLanguageToSpeechLocale("zh-CN")).toBe("zh-CN");
    expect(mapUiLanguageToSpeechLocale("ko")).toBe("ko-KR");
    expect(mapUiLanguageToSpeechLocale("es")).toBe("es-ES");
    expect(mapUiLanguageToSpeechLocale("pt")).toBe("pt-BR");
    expect(mapUiLanguageToSpeechLocale("vi")).toBe("vi-VN");
    expect(mapUiLanguageToSpeechLocale("tl")).toBe("fil-PH");
    expect(mapUiLanguageToSpeechLocale("unknown")).toBe("en-US");
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

  it("retains, fades, and expires the prior companion context after a cutoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const initialMessages = [
      message("old", 50),
      message("recent-1", 110),
      message("recent-2", 120),
      message("recent-3", 130),
    ];
    const { result, rerender } = renderHook(
      (props: {
        activeConversationId: string;
        companionMessageCutoffTs: number;
        visibleMsgs: ConversationMessage[];
      }) =>
        useGameModalMessages({
          ...props,
          isGameModal: true,
        }),
      {
        initialProps: {
          activeConversationId: "conversation-1",
          companionMessageCutoffTs: 100,
          visibleMsgs: initialMessages,
        },
      },
    );

    expect(result.current.gameModalVisibleMsgs.map(({ id }) => id)).toEqual([
      "recent-2",
      "recent-3",
    ]);

    act(() => {
      rerender({
        activeConversationId: "conversation-1",
        companionMessageCutoffTs: 200,
        visibleMsgs: [...initialMessages, message("new", 210)],
      });
    });
    expect(
      result.current.companionCarryover?.messages.map(({ id }) => id),
    ).toEqual(["recent-2", "recent-3"]);
    expect(result.current.gameModalCarryoverOpacity).toBe(1);

    act(() => {
      vi.advanceTimersByTime(32_500);
    });
    expect(result.current.gameModalCarryoverOpacity).toBeCloseTo(0.5, 1);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.companionCarryover).toBeNull();

    act(() => {
      rerender({
        activeConversationId: "conversation-2",
        companionMessageCutoffTs: 300,
        visibleMsgs: [message("other-thread", 310)],
      });
    });
    expect(result.current.gameModalVisibleMsgs.map(({ id }) => id)).toEqual([
      "other-thread",
    ]);
    vi.useRealTimers();
  });
});
