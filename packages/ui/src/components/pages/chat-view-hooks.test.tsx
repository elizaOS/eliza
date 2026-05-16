// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import type { VoiceChatState } from "../../voice/voice-chat-types";
import { useChatVoiceController } from "./chat-view-hooks";

vi.mock("../../api/client", () => ({
  client: {
    getConfig: vi.fn(async () => ({})),
    updateConfig: vi.fn(async () => ({})),
  },
}));

vi.mock("../../hooks/useContinuousChat", () => ({
  DEFAULT_VOICE_CONTINUOUS_MODE: "off",
  useContinuousChat: vi.fn(() => ({
    enabled: false,
    setEnabled: vi.fn(),
    mode: "off",
    setMode: vi.fn(),
  })),
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

vi.mock("../companion/injected", () => ({
  useCompanionSceneStatus: vi.fn(() => ({ avatarReady: true })),
}));

const useVoiceChatMock = vi.mocked(useVoiceChat);

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
      result.current.handleSpeakMessage("message-1", "hello from Milady");
    });

    expect(voiceState.speak).toHaveBeenCalledWith("hello from Milady", {
      telemetry: { messageId: "message-1" },
    });
  });
});
