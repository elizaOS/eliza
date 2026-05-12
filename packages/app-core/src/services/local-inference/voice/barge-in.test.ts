/**
 * BargeInController tests — the blip-vs-words distinction.
 *
 *   - legacy `attach`/`onMicActive`/`cancelSignal`/`reset` still work
 *     (`VoiceScheduler` depends on them).
 *   - VAD-driven flow while the agent is speaking:
 *       speech-active → pause-tts
 *       blip          → resume-tts
 *       ASR word      → hard-stop (cancel token tripped, AbortSignal aborted)
 *       no ASR word   → resume-tts after the grace window
 *   - barge-in is inert while the agent is NOT speaking.
 */

import { describe, expect, it, vi } from "vitest";
import { BargeInController } from "./barge-in";
import type { BargeInSignal, VadEvent, VadEventListener } from "./types";

/** A standalone fake VAD event source the controller can bind to. */
class FakeVad {
  private readonly listeners = new Set<VadEventListener>();
  onVadEvent(l: VadEventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: VadEvent): void {
    for (const l of this.listeners) l(e);
  }
}

function speechActive(ts: number): VadEvent {
  return {
    type: "speech-active",
    timestampMs: ts,
    probability: 0.9,
    speechDurationMs: 200,
  };
}
function blip(ts: number): VadEvent {
  return { type: "blip", timestampMs: ts, durationMs: 80, peakRms: 0.2 };
}

describe("BargeInController — legacy API", () => {
  it("flips the cancel signal and notifies listeners on onMicActive", () => {
    const c = new BargeInController();
    let n = 0;
    c.attach({ onCancel: () => n++ });
    expect(c.cancelSignal().cancelled).toBe(false);
    c.onMicActive();
    expect(c.cancelSignal().cancelled).toBe(true);
    expect(n).toBe(1);
  });

  it("reset issues a fresh cancel signal", () => {
    const c = new BargeInController();
    c.onMicActive();
    expect(c.cancelSignal().cancelled).toBe(true);
    c.reset();
    expect(c.cancelSignal().cancelled).toBe(false);
    expect(c.currentCancelToken()).toBeNull();
  });
});

describe("BargeInController — VAD-driven barge-in", () => {
  it("does nothing while the agent is not speaking", () => {
    const c = new BargeInController();
    const vad = new FakeVad();
    c.bindVad(vad);
    const signals: BargeInSignal[] = [];
    c.onSignal((s) => signals.push(s));
    vad.emit(speechActive(100));
    vad.emit(blip(200));
    expect(signals).toHaveLength(0);
  });

  it("pauses TTS on speech-active and resumes on a blip", () => {
    const c = new BargeInController();
    const vad = new FakeVad();
    c.bindVad(vad);
    c.setAgentSpeaking(true);
    const signals: BargeInSignal[] = [];
    c.onSignal((s) => signals.push(s));

    vad.emit(speechActive(100));
    expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
    // A second speech-active while already paused — no duplicate pause.
    vad.emit(speechActive(132));
    expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
    // Blip → resume.
    vad.emit(blip(300));
    expect(signals.map((s) => s.type)).toEqual(["pause-tts", "resume-tts"]);
  });

  it("hard-stops (cancel token + AbortSignal) when ASR confirms a word", () => {
    const c = new BargeInController();
    const vad = new FakeVad();
    c.bindVad(vad);
    c.setAgentSpeaking(true);
    const signals: BargeInSignal[] = [];
    c.onSignal((s) => signals.push(s));
    let onCancelCalls = 0;
    c.attach({ onCancel: () => onCancelCalls++ });

    vad.emit(speechActive(100)); // pause-tts
    expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);

    c.onWordsDetected({
      wordCount: 1,
      partialText: "hey wait",
      timestampMs: 250,
    });

    expect(signals.map((s) => s.type)).toEqual(["pause-tts", "hard-stop"]);
    const hard = signals.find((s) => s.type === "hard-stop");
    expect(hard && hard.type === "hard-stop").toBe(true);
    if (hard && hard.type === "hard-stop") {
      expect(hard.token.cancelled).toBe(true);
      expect(hard.token.reason).toBe("barge-in-words");
      expect(hard.token.signal.aborted).toBe(true);
    }
    expect(c.currentCancelToken()?.cancelled).toBe(true);
    expect(c.cancelSignal().cancelled).toBe(true);
    expect(onCancelCalls).toBe(1);
  });

  it("ignores onWordsDetected with zero words", () => {
    const c = new BargeInController();
    const vad = new FakeVad();
    c.bindVad(vad);
    c.setAgentSpeaking(true);
    const signals: BargeInSignal[] = [];
    c.onSignal((s) => signals.push(s));
    vad.emit(speechActive(100));
    c.onWordsDetected({ wordCount: 0, partialText: "", timestampMs: 200 });
    expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
  });

  it("resumes TTS after the grace window when ASR never confirms a word", () => {
    vi.useFakeTimers();
    try {
      const c = new BargeInController({ wordsGraceMs: 500 });
      const vad = new FakeVad();
      c.bindVad(vad);
      c.setAgentSpeaking(true);
      const signals: BargeInSignal[] = [];
      c.onSignal((s) => signals.push(s));

      vad.emit(speechActive(100)); // pause-tts, arms 500ms deadline
      expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
      vad.emit({
        type: "speech-pause",
        timestampMs: 300,
        pauseDurationMs: 200,
      });
      vad.emit({ type: "speech-end", timestampMs: 500, speechDurationMs: 350 });
      // Not yet past the grace window.
      vi.advanceTimersByTime(400);
      expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
      // Past it → resume.
      vi.advanceTimersByTime(200);
      expect(signals.map((s) => s.type)).toEqual(["pause-tts", "resume-tts"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a word arriving before the grace deadline cancels the resume", () => {
    vi.useFakeTimers();
    try {
      const c = new BargeInController({ wordsGraceMs: 500 });
      const vad = new FakeVad();
      c.bindVad(vad);
      c.setAgentSpeaking(true);
      const signals: BargeInSignal[] = [];
      c.onSignal((s) => signals.push(s));
      vad.emit(speechActive(100));
      vi.advanceTimersByTime(300);
      c.onWordsDetected({
        wordCount: 2,
        partialText: "stop please",
        timestampMs: 400,
      });
      vi.advanceTimersByTime(500);
      expect(signals.map((s) => s.type)).toEqual(["pause-tts", "hard-stop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale ASR words after the interruption window resumes TTS", () => {
    vi.useFakeTimers();
    try {
      const c = new BargeInController({ wordsGraceMs: 500 });
      const vad = new FakeVad();
      c.bindVad(vad);
      c.setAgentSpeaking(true);
      const signals: BargeInSignal[] = [];
      c.onSignal((s) => signals.push(s));

      vad.emit(speechActive(100));
      vi.advanceTimersByTime(600);
      expect(signals.map((s) => s.type)).toEqual(["pause-tts", "resume-tts"]);

      c.onWordsDetected({
        wordCount: 2,
        partialText: "late stale",
        timestampMs: 800,
      });
      expect(signals.map((s) => s.type)).toEqual(["pause-tts", "resume-tts"]);
      expect(c.currentCancelToken()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("setAgentSpeaking(false) clears a pending word-confirm without resuming", () => {
    vi.useFakeTimers();
    try {
      const c = new BargeInController({ wordsGraceMs: 500 });
      const vad = new FakeVad();
      c.bindVad(vad);
      c.setAgentSpeaking(true);
      const signals: BargeInSignal[] = [];
      c.onSignal((s) => signals.push(s));
      vad.emit(speechActive(100)); // pause-tts
      c.setAgentSpeaking(false); // agent finished its turn
      vi.advanceTimersByTime(1000);
      expect(signals.map((s) => s.type)).toEqual(["pause-tts"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unbindVad detaches the controller from VAD events", () => {
    const c = new BargeInController();
    const vad = new FakeVad();
    const unbind = c.bindVad(vad);
    c.setAgentSpeaking(true);
    const signals: BargeInSignal[] = [];
    c.onSignal((s) => signals.push(s));
    unbind();
    vad.emit(speechActive(100));
    expect(signals).toHaveLength(0);
  });
});
