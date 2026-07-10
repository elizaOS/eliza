// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";

// Hoisted so the vi.mock factories below (which are lifted above imports) can
// reference them. `cfg` lets individual tests vary speaking / bootstrap state.
const hoisted = vi.hoisted(() => ({
  queueAssistantSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  cfg: {
    isSpeaking: false,
    voiceBootstrapTick: 1,
    // Full voice config the useVoiceConfig mock returns; tests vary `asr` to
    // check the hook surfaces the resolved ASR provider for the capture path.
    voiceConfig: { provider: "local-inference" } as Record<string, unknown>,
  },
}));

// The single TTS engine — mocked to capture the output calls the overlay makes.
vi.mock("../../hooks/useVoiceChat", () => ({
  useVoiceChat: () => ({
    queueAssistantSpeech: hoisted.queueAssistantSpeech,
    stopSpeaking: hoisted.stopSpeaking,
    isSpeaking: hoisted.cfg.isSpeaking,
    // Unused by the output hook, present to satisfy the shape.
    isListening: false,
    captureMode: "idle",
    mouthOpen: 0,
    interimTranscript: "",
    supported: true,
    usingAudioAnalysis: false,
    toggleListening: () => {},
    startListening: async () => {},
    stopListening: async () => {},
    speak: () => {},
    voiceUnlockedGeneration: 0,
    assistantTtsQuality: "standard",
  }),
}));

vi.mock("../../voice/useVoiceConfig", () => ({
  useVoiceConfig: () => ({
    voiceConfig: hoisted.cfg.voiceConfig,
    voiceBootstrapTick: hoisted.cfg.voiceBootstrapTick,
    reloadVoiceConfig: () => {},
  }),
}));

import {
  type ShellVoiceOutputOptions,
  useShellVoiceOutput,
} from "./useShellVoiceOutput";

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, timestamp: 1 };
}
function assistantMsg(id: string, text: string): ConversationMessage {
  return { id, role: "assistant", text, timestamp: 2 };
}
function proactiveMsg(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: 2,
    source: "proactive-interaction",
  };
}

const BASE: ShellVoiceOutputOptions = {
  conversationMessages: [],
  chatSending: false,
  recording: false,
  lastTurnVoice: false,
  agentVoiceMuted: false,
  toggleAgentVoiceMute: vi.fn(),
  uiLanguage: "en",
  cloudConnected: false,
};

function render(initial: ShellVoiceOutputOptions) {
  return renderHook(
    (props: ShellVoiceOutputOptions) => useShellVoiceOutput(props),
    {
      initialProps: initial,
    },
  );
}

beforeEach(() => {
  hoisted.queueAssistantSpeech.mockClear();
  hoisted.stopSpeaking.mockClear();
  hoisted.cfg.isSpeaking = false;
  hoisted.cfg.voiceBootstrapTick = 1;
  hoisted.cfg.voiceConfig = { provider: "local-inference" };
});

afterEach(cleanup);

describe("useShellVoiceOutput", () => {
  it("speaks the assistant reply after a voice turn", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "what's the weather")],
    });
    // No assistant message yet — nothing spoken.
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();

    rerender({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "what's the weather"),
        assistantMsg("a1", "It is sunny."),
      ],
    });

    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledWith(
      "a1",
      "It is sunny.",
      true,
      { replace: true },
    );
  });

  it("stays silent when the latest turn was typed, not voice", () => {
    render({
      ...BASE,
      lastTurnVoice: false,
      conversationMessages: [
        userMsg("u1", "typed question"),
        assistantMsg("a1", "Typed answer."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("does not re-speak the same assistant message", () => {
    const messages = [userMsg("u1", "hi"), assistantMsg("a1", "Hello.")];
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: messages,
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);

    // Same content, new array identity (a re-render with no new text).
    rerender({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [...messages],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
  });

  it("speaks streaming growth as it arrives, then the final text", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      chatSending: true,
      conversationMessages: [userMsg("u1", "hi"), assistantMsg("a1", "Hel")],
    });
    rerender({
      ...BASE,
      lastTurnVoice: true,
      chatSending: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Hello wor"),
      ],
    });
    rerender({
      ...BASE,
      lastTurnVoice: true,
      chatSending: false,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Hello world."),
      ],
    });

    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(3);
    // First clip of a new message replaces prior playback; continuations append.
    expect(hoisted.queueAssistantSpeech).toHaveBeenNthCalledWith(
      1,
      "a1",
      "Hel",
      false,
      {
        replace: true,
      },
    );
    expect(hoisted.queueAssistantSpeech).toHaveBeenNthCalledWith(
      3,
      "a1",
      "Hello world.",
      true,
      { replace: false },
    );
  });

  it("keeps speaking a captured voice reply even after a later typed turn (per-message)", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "hey"), assistantMsg("a1", "Hi")],
    });
    // a1 captured as a voice reply (lastTurnVoice was true) and spoken.
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);

    // The user types mid-stream → lastTurnVoice flips false, but a1 keeps
    // growing. The OLD shared-boolean gate would silence it here; the
    // per-message capture keeps speaking a1's continuation.
    rerender({
      ...BASE,
      lastTurnVoice: false,
      conversationMessages: [
        userMsg("u1", "hey"),
        assistantMsg("a1", "Hi there."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(2);
    expect(hoisted.queueAssistantSpeech).toHaveBeenLastCalledWith(
      "a1",
      "Hi there.",
      true,
      { replace: false },
    );

    // A reply to the typed turn (new id, lastTurnVoice false) is NOT spoken.
    rerender({
      ...BASE,
      lastTurnVoice: false,
      conversationMessages: [
        userMsg("u1", "hey"),
        assistantMsg("a1", "Hi there."),
        userMsg("u2", "typed"),
        assistantMsg("a2", "Typed answer."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(2);
  });

  it("barges in — stops speech the instant the mic opens", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Talking…"),
      ],
    });
    hoisted.stopSpeaking.mockClear();

    rerender({
      ...BASE,
      lastTurnVoice: true,
      recording: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Talking…"),
      ],
    });
    expect(hoisted.stopSpeaking).toHaveBeenCalled();
  });

  it("uses the shared mute state, stops speech, and silences later replies", () => {
    const toggleAgentVoiceMute = vi.fn();
    const firstMessages = [userMsg("u1", "hi"), assistantMsg("a1", "First.")];
    const { result, rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      toggleAgentVoiceMute,
      conversationMessages: firstMessages,
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggleAgentVoiceMute();
    });
    expect(toggleAgentVoiceMute).toHaveBeenCalledTimes(1);

    // AppContext commits the shared mute state. The shell immediately stops the
    // same playback and reads muted everywhere the composer does.
    rerender({
      ...BASE,
      lastTurnVoice: true,
      agentVoiceMuted: true,
      toggleAgentVoiceMute,
      conversationMessages: firstMessages,
    });
    expect(result.current.agentVoiceMuted).toBe(true);
    expect(hoisted.stopSpeaking).toHaveBeenCalled();

    // A new reply arrives while muted — it must not be spoken.
    rerender({
      ...BASE,
      lastTurnVoice: true,
      agentVoiceMuted: true,
      toggleAgentVoiceMute,
      conversationMessages: [
        ...firstMessages,
        userMsg("u2", "again"),
        assistantMsg("a2", "Second."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
  });

  it("waits for the voice config to load before speaking", () => {
    hoisted.cfg.voiceBootstrapTick = 0;
    render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "hi"), assistantMsg("a1", "Ready?")],
    });
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("reflects the engine's speaking state", () => {
    hoisted.cfg.isSpeaking = true;
    const { result } = render(BASE);
    expect(result.current.speaking).toBe(true);
  });

  // Regression: the overlay's mic capture (useShellController → createVoiceCapture)
  // reads the resolved ASR provider from here. Without it the factory only ever
  // saw `undefined` and could never reach the eliza-cloud / openai cloud STT
  // path, silently degrading to local-inference-or-browser.
  it("surfaces the resolved ASR provider from the voice config", () => {
    hoisted.cfg.voiceConfig = {
      provider: "eliza-cloud",
      asr: { provider: "eliza-cloud" },
    };
    const { result } = render(BASE);
    expect(result.current.asrProvider).toBe("eliza-cloud");
  });

  it("surfaces undefined ASR provider when the config has no asr block", () => {
    hoisted.cfg.voiceConfig = { provider: "local-inference" };
    const { result } = render(BASE);
    expect(result.current.asrProvider).toBeUndefined();
  });

  // #8792: proactive interaction comments are text-only by default.
  it("does NOT speak a proactive interaction comment outside hands-free voice mode", () => {
    render({
      ...BASE,
      lastTurnVoice: false,
      conversationMessages: [proactiveMsg("p1", "Want me to pull balances?")],
    });
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("DOES speak a proactive interaction comment while hands-free (last turn voice)", () => {
    render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "spoken turn"),
        proactiveMsg("p1", "Want me to pull balances?"),
      ],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledWith(
      "p1",
      "Want me to pull balances?",
      true,
      { replace: true },
    );
  });
});
