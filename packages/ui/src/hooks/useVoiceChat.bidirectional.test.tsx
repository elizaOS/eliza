// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceChat } from "./useVoiceChat";

type FakeSpeechRecognitionResultEvent = {
  resultIndex: number;
  results: Array<{
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  }>;
};

class FakeSpeechRecognition extends EventTarget {
  static instances: FakeSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = "en-US";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: FakeSpeechRecognitionResultEvent) => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    super();
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.started = true;
    this.onstart?.();
  }

  stop() {
    this.stopped = true;
    this.onend?.();
  }

  abort() {
    this.stopped = true;
    this.onend?.();
  }

  emitResult(transcript: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal,
          0: { transcript, confidence: 0.93 },
        },
      ],
    });
  }
}

class FakeSpeechSynthesisUtterance extends EventTarget {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    super();
    this.text = text;
  }
}

const speechSynthesisMock = {
  speaking: false,
  pending: false,
  spoken: [] as FakeSpeechSynthesisUtterance[],
  cancel: vi.fn(() => {
    speechSynthesisMock.speaking = false;
    speechSynthesisMock.pending = false;
  }),
  getVoices: vi.fn(() => []),
  speak: vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
    speechSynthesisMock.spoken.push(utterance);
    speechSynthesisMock.speaking = true;
    utterance.onstart?.();
  }),
};

function installVoiceBrowserMocks() {
  FakeSpeechRecognition.instances = [];
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speaking = false;
  speechSynthesisMock.pending = false;
  speechSynthesisMock.cancel.mockClear();
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.getVoices.mockClear();

  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 16);
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => {
    clearTimeout(id);
  }) as typeof window.cancelAnimationFrame;
}

describe("useVoiceChat bidirectional browser voice", () => {
  beforeEach(() => {
    installVoiceBrowserMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("speaks the requested partial thinking phrase before final completion", async () => {
    const onPlaybackStart = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        onPlaybackStart,
      }),
    );

    const thinkingPhrase =
      "hmm, okay, that's a good idea, let me think for a second";

    act(() => {
      result.current.queueAssistantSpeech(
        "msg-thinking",
        thinkingPhrase,
        false,
      );
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(speechSynthesisMock.spoken[0]?.text).toBe(thinkingPhrase);
    expect(onPlaybackStart).toHaveBeenCalledWith(
      expect.objectContaining({
        text: thinkingPhrase,
        provider: "browser",
        segment: "full",
      }),
    );

    act(() => {
      speechSynthesisMock.spoken[0]?.onend?.();
    });

    act(() => {
      result.current.queueAssistantSpeech(
        "msg-thinking",
        `${thinkingPhrase}. I will wait for the next signal.`,
        true,
      );
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(2);
    });
    expect(speechSynthesisMock.spoken[1]?.text).toContain(
      "I will wait for the next signal.",
    );
  });

  it("submits final microphone transcript through the real browser recognition path", async () => {
    const onTranscript = vi.fn();
    const onTranscriptPreview = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        onTranscriptPreview,
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(result.current.captureMode).toBe("push-to-talk");

    act(() => {
      recognition?.emitResult("create a new view", true);
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(onTranscriptPreview).toHaveBeenCalledWith(
      "create a new view",
      expect.objectContaining({
        isFinal: true,
        mode: "push-to-talk",
      }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "create a new view",
      expect.objectContaining({
        isFinal: true,
        mode: "push-to-talk",
        turn: expect.objectContaining({
          text: "create a new view",
          source: "browser",
        }),
      }),
    );
  });

  it("submits final passive transcripts immediately while keeping always-on recognition alive", async () => {
    const onTranscript = vi.fn();
    const onTranscriptPreview = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        onTranscriptPreview,
      }),
    );

    await act(async () => {
      await result.current.startListening("passive");
    });

    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(result.current.captureMode).toBe("passive");

    act(() => {
      recognition?.emitResult("create a remote ledger while live", true);
    });

    expect(onTranscriptPreview).toHaveBeenCalledWith(
      "create a remote ledger while live",
      expect.objectContaining({
        isFinal: true,
        mode: "passive",
      }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "create a remote ledger while live",
      expect.objectContaining({
        isFinal: true,
        mode: "passive",
        turn: expect.objectContaining({
          text: "create a remote ledger while live",
          source: "browser",
        }),
      }),
    );
    expect(result.current.isListening).toBe(true);
    expect(result.current.captureMode).toBe("passive");
    expect(recognition?.stopped).toBe(false);
  });

  it("cancels assistant playback when user speech barges in", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
      }),
    );

    act(() => {
      result.current.speak("The assistant is still speaking.");
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.startListening("hands-free");
    });
    const recognition = FakeSpeechRecognition.instances[0];

    act(() => {
      recognition?.emitResult("interrupt with my voice", false);
    });

    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
  });

  it("keeps hands-free capture alive while speaking the wait phrase", async () => {
    const onTranscript = vi.fn();
    const onTranscriptPreview = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        onTranscriptPreview,
      }),
    );

    await act(async () => {
      await result.current.startListening("hands-free");
    });
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(result.current.captureMode).toBe("hands-free");

    const thinkingPhrase =
      "hmm, okay, that's a good idea, let me think for a second";
    act(() => {
      result.current.queueAssistantSpeech(
        "msg-hands-free-wait",
        thinkingPhrase,
        false,
      );
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(speechSynthesisMock.spoken[0]?.text).toBe(thinkingPhrase);
    expect(result.current.isListening).toBe(true);
    expect(result.current.captureMode).toBe("hands-free");

    act(() => {
      speechSynthesisMock.spoken[0]?.onend?.();
      recognition?.emitResult("now send the follow up", true);
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(onTranscriptPreview).toHaveBeenCalledWith(
      "now send the follow up",
      expect.objectContaining({
        isFinal: true,
        mode: "hands-free",
      }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "now send the follow up",
      expect.objectContaining({
        isFinal: true,
        mode: "hands-free",
        turn: expect.objectContaining({
          text: "now send the follow up",
          source: "browser",
        }),
      }),
    );
  });
});
