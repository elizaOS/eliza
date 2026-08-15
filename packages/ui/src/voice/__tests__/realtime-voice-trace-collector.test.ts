/** Deterministic normal-chat adapter tests for the shared voice trace schema. */

import { describe, expect, it, vi } from "vitest";
import { createNormalVoiceTraceCollector } from "../realtime-voice-trace-collector";

describe("normal realtime voice trace collector", () => {
  it("completes a truthful spoken trace in the browser clock domain", () => {
    const completed = vi.fn();
    const collector = createNormalVoiceTraceCollector(completed);
    collector.resetSession("session-1");
    collector.updateDimensions({
      transport: "websocket",
      sttProvider: "cartesia-ink-2",
      ttsProvider: "cartesia-sonic-3.5",
      frameDurationMs: 20,
      sampleRateHz: 16_000,
    });
    const marks = [
      ["acoustic_speech_ended", 100],
      ["stt_final", 180],
      ["turn_committed", 181],
      ["router_decided", 182],
      ["llm_requested", 183],
      ["llm_first_text", 420],
      ["speakable_text_ready", 500],
      ["tts_requested", 501],
      ["tts_first_byte", 620],
      ["first_audio_playout", 640],
      ["turn_end(spoken)", 700],
      ["playback_drained", 900],
    ] as const;
    let result = null;
    for (const [name, atMs] of marks) {
      result = collector.accept({ name, traceId: "turn-1", atMs }) ?? result;
    }
    expect(result?.coverage).toEqual(
      expect.objectContaining({ complete: true, missingMarks: [] }),
    );
    expect(result?.trace).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        outcome: "spoken",
        marks: expect.objectContaining({
          llm_first_useful_text: 420,
          last_audio_playout: 900,
        }),
      }),
    );
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("reports missing evidence instead of inventing a passing trace", () => {
    const collector = createNormalVoiceTraceCollector();
    collector.accept({ name: "stt_final", traceId: "turn-2", atMs: 10 });
    expect(
      collector.accept({
        name: "turn_end(spoken)",
        traceId: "turn-2",
        atMs: 20,
      }),
    ).toBeNull();
    const result = collector.accept({
      name: "playback_drained",
      traceId: "turn-2",
      atMs: 30,
    });
    expect(result?.coverage.complete).toBe(false);
    expect(result?.coverage.missingMarks).toContain("acoustic_speech_ended");
    expect(result?.coverage.missingMarks).toContain("first_audio_playout");
  });

  it("isolates session epochs and ignores uncorrelated diagnostics", () => {
    const collector = createNormalVoiceTraceCollector();
    collector.accept({ name: "stt_final", traceId: "old", atMs: 10 });
    collector.resetSession("session-2");
    expect(
      collector.accept({ name: "turn_end(spoken)", traceId: null, atMs: 20 }),
    ).toBeNull();
    const result = collector.accept({
      name: "turn_end(no_response)",
      traceId: "new",
      atMs: 30,
    });
    expect(result?.trace.sessionId).toBe("session-2");
    expect(result?.trace.turnId).toBe("new");
  });

  it("scores confirmed interruption from local pause through server ack", () => {
    const collector = createNormalVoiceTraceCollector();
    collector.accept({
      name: "local_speech_detected",
      traceId: "response-1",
      atMs: 100,
    });
    collector.accept({
      name: "local_playback_paused",
      traceId: "response-1",
      atMs: 106,
    });
    collector.accept({
      name: "server_interrupt_ack",
      traceId: "response-1",
      atMs: 160,
    });
    const result = collector.accept({
      name: "interrupted",
      traceId: "response-1",
      atMs: 161,
    });
    expect(result?.trace.outcome).toBe("interrupted");
    expect(result?.coverage).toEqual(
      expect.objectContaining({ complete: true, missingMarks: [] }),
    );
  });
});
