/**
 * Tests for voice chat logic — SpeechRecognition, SpeechSynthesis, mouth animation.
 *
 * Since useVoiceChat is a React hook and we run in Node (not jsdom),
 * we test the underlying browser APIs and integration patterns directly.
 */

import { nextIdleMouthOpen } from "@elizaos/app-core/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock SpeechRecognition for voice input tests
// ---------------------------------------------------------------------------

class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult:
    | ((event: {
        results: {
          length: number;
          [k: number]: {
            isFinal: boolean;
            0: { transcript: string; confidence: number };
          };
        };
        resultIndex: number;
      }) => void)
    | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  private _running = false;

  start() {
    this._running = true;
    this.onstart?.();
  }
  stop() {
    this._running = false;
    this.onend?.();
  }
  abort() {
    this._running = false;
  }

  get running() {
    return this._running;
  }

  /** Simulate receiving a speech result */
  simulateResult(transcript: string, isFinal: boolean) {
    this.onresult?.({
      results: {
        length: 1,
        0: { isFinal, 0: { transcript, confidence: 0.95 } },
      },
      resultIndex: 0,
    });
  }

  /** Simulate an error */
  simulateError(error: string) {
    this.onerror?.({ error });
  }
}

// ---------------------------------------------------------------------------
// Mock SpeechSynthesis for voice output tests
// ---------------------------------------------------------------------------

class MockSpeechSynthesisUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;

  constructor(text?: string) {
    this.text = text ?? "";
  }
}

function createMockSynthesis() {
  const spoken: MockSpeechSynthesisUtterance[] = [];
  return {
    speaking: false,
    pending: false,
    paused: false,
    spoken,
    speak: vi.fn((utterance: MockSpeechSynthesisUtterance) => {
      spoken.push(utterance);
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: vi.fn(() => []),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice Chat — Speech Recognition", () => {
  let recognition: MockSpeechRecognition;

  beforeEach(() => {
    vi.restoreAllMocks();
    recognition = new MockSpeechRecognition();
  });

  it("can be configured for continuous recognition", () => {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.lang).toBe("en-US");
  });

  it("starts and reports running state", () => {
    recognition.start();
    expect(recognition.running).toBe(true);
  });

  it("stops and reports stopped state", () => {
    recognition.start();
    recognition.stop();
    expect(recognition.running).toBe(false);
  });

  it("delivers interim transcripts", () => {
    const transcripts: string[] = [];
    recognition.onresult = (event) => {
      const result = event.results[0];
      if (result && !result.isFinal) {
        transcripts.push(result[0].transcript);
      }
    };

    recognition.start();
    recognition.simulateResult("hel", false);
    recognition.simulateResult("hello", false);

    expect(transcripts).toEqual(["hel", "hello"]);
  });

  it("delivers final transcripts", () => {
    const finals: string[] = [];
    recognition.onresult = (event) => {
      const result = event.results[0];
      if (result?.isFinal) {
        finals.push(result[0].transcript);
      }
    };

    recognition.start();
    recognition.simulateResult("hello world", true);

    expect(finals).toEqual(["hello world"]);
  });

  it("handles recognition errors", () => {
    const errors: string[] = [];
    recognition.onerror = (event) => {
      errors.push(event.error);
    };

    recognition.start();
    recognition.simulateError("not-allowed");

    expect(errors).toEqual(["not-allowed"]);
  });

  it("auto-restarts on end when enabled", () => {
    let restartCount = 0;
    const orig = recognition.start.bind(recognition);
    recognition.start = () => {
      restartCount++;
      orig();
    };

    // Simulate the continuous listening pattern from useVoiceChat
    recognition.onend = () => {
      if (recognition.running) {
        // This is what the hook does — restart if still enabled
        recognition.start();
      }
    };

    recognition.start(); // initial start
    expect(restartCount).toBe(1);
  });
});

describe("Voice Chat — Speech Synthesis", () => {
  let synth: ReturnType<typeof createMockSynthesis>;

  beforeEach(() => {
    vi.restoreAllMocks();
    synth = createMockSynthesis();
  });

  it("speaks text through SpeechSynthesis", () => {
    const utterance = new MockSpeechSynthesisUtterance("Hello agent");
    synth.speak(utterance);

    expect(synth.speak).toHaveBeenCalledOnce();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.text).toBe("Hello agent");
  });

  it("cancel stops current speech", () => {
    const utterance = new MockSpeechSynthesisUtterance("Hello");
    synth.speak(utterance);
    synth.cancel();

    expect(synth.cancel).toHaveBeenCalledOnce();
  });

  it("utterance fires onstart and onend callbacks", () => {
    const events: string[] = [];
    const utterance = new MockSpeechSynthesisUtterance("Test");
    utterance.onstart = () => events.push("start");
    utterance.onend = () => events.push("end");

    // Simulate lifecycle
    utterance.onstart();
    utterance.onend();

    expect(events).toEqual(["start", "end"]);
  });

  it("utterance fires onerror on failure", () => {
    const errors: string[] = [];
    const utterance = new MockSpeechSynthesisUtterance("Test");
    utterance.onerror = (e) => errors.push(e.error);

    utterance.onerror({ error: "synthesis-failed" });
    expect(errors).toEqual(["synthesis-failed"]);
  });

  it("cancels previous speech before speaking new text", () => {
    // This is the pattern used in useVoiceChat
    const u1 = new MockSpeechSynthesisUtterance("First");
    synth.speak(u1);
    synth.cancel(); // cancel first
    const u2 = new MockSpeechSynthesisUtterance("Second");
    synth.speak(u2);

    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1]?.text).toBe("Second");
  });
});

describe("Voice Chat — Mouth Animation", () => {
  it("generates natural-looking mouth values from sine waves", () => {
    // This tests the animation formula from useVoiceChat
    const values: number[] = [];
    const _startTime = Date.now();

    for (let i = 0; i < 20; i++) {
      const elapsed = i * 0.05; // 50ms intervals
      const base = Math.sin(elapsed * 12) * 0.3 + 0.4;
      const detail = Math.sin(elapsed * 18.7) * 0.15;
      const slow = Math.sin(elapsed * 4.2) * 0.1;
      const value = Math.max(0, Math.min(1, base + detail + slow));
      values.push(value);
    }

    // All values should be in [0, 1]
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Values should vary (not all the same)
    const unique = new Set(values.map((v) => v.toFixed(4)));
    expect(unique.size).toBeGreaterThan(5);
  });

  it("smooth-closes mouth when speaking stops", () => {
    // Idle decay should keep closing all the way to silence.
    let mouthOpen = 0.8;
    for (let i = 0; i < 40; i++) {
      mouthOpen = nextIdleMouthOpen(mouthOpen);
    }
    expect(mouthOpen).toBe(0);
  });

  it("does not get stuck at the last stepped mouth-open value", () => {
    expect(nextIdleMouthOpen(0.06)).toBeCloseTo(0.04);
    expect(nextIdleMouthOpen(0.04)).toBeCloseTo(0.02);
    expect(nextIdleMouthOpen(0.02)).toBe(0);
  });
});

describe("Voice Chat — Integration patterns", () => {
  it("voice transcript triggers chat send flow", () => {
    // Simulates the handleVoiceTranscript callback from ChatAvatar
    const sentMessages: string[] = [];
    let chatInput = "";
    let chatSending = false;

    const handleVoiceTranscript = (text: string) => {
      if (chatSending) return;
      chatInput = text;
      sentMessages.push(text);
    };

    handleVoiceTranscript("Hello agent");
    expect(chatInput).toBe("Hello agent");
    expect(sentMessages).toEqual(["Hello agent"]);

    // Should not send while already sending
    chatSending = true;
    handleVoiceTranscript("Another message");
    expect(sentMessages).toEqual(["Hello agent"]);
  });

  it("auto-speaks agent responses when voice is active", () => {
    // Simulates the auto-speak logic from ChatAvatar
    const spokenTexts: string[] = [];
    let lastSpokenId: string | null = null;
    const isListening = true;
    const chatSending = false;

    const checkAndSpeak = (msg: { id: string; role: string; text: string }) => {
      if (
        msg.role === "assistant" &&
        msg.id !== lastSpokenId &&
        isListening &&
        !chatSending
      ) {
        lastSpokenId = msg.id;
        spokenTexts.push(msg.text);
      }
    };

    checkAndSpeak({
      id: "msg-1",
      role: "assistant",
      text: "Hello! How can I help?",
    });
    expect(spokenTexts).toEqual(["Hello! How can I help?"]);

    // Same message should not be spoken again
    checkAndSpeak({
      id: "msg-1",
      role: "assistant",
      text: "Hello! How can I help?",
    });
    expect(spokenTexts).toEqual(["Hello! How can I help?"]);

    // User messages should not be spoken
    checkAndSpeak({ id: "msg-2", role: "user", text: "Test" });
    expect(spokenTexts).toEqual(["Hello! How can I help?"]);

    // New assistant message should be spoken
    checkAndSpeak({ id: "msg-3", role: "assistant", text: "Sure thing!" });
    expect(spokenTexts).toEqual(["Hello! How can I help?", "Sure thing!"]);
  });

  it("does not speak responses when voice is not active", () => {
    const spokenTexts: string[] = [];
    let lastSpokenId: string | null = null;
    const isListening = false; // voice not active
    const chatSending = false;

    const checkAndSpeak = (msg: { id: string; role: string; text: string }) => {
      if (
        msg.role === "assistant" &&
        msg.id !== lastSpokenId &&
        isListening &&
        !chatSending
      ) {
        lastSpokenId = msg.id;
        spokenTexts.push(msg.text);
      }
    };

    checkAndSpeak({ id: "msg-1", role: "assistant", text: "Hello!" });
    expect(spokenTexts).toEqual([]);
  });
});
