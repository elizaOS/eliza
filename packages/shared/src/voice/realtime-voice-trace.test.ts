import { describe, expect, it } from "vitest";
import {
  createRealtimeVoiceTrace,
  finalizeRealtimeVoiceTrace,
  inspectRealtimeVoiceTraceCoverage,
  markRealtimeVoiceTrace,
  noteLateRealtimeVoiceAudioFrame,
  type RealtimeVoiceTrace,
  type RealtimeVoiceTraceMark,
  summarizeRealtimeVoiceLatency,
} from "./realtime-voice-trace";

function spokenTrace(offset = 0, finalize = true): RealtimeVoiceTrace {
  let trace = createRealtimeVoiceTrace({
    sessionId: `session-${offset}`,
    turnId: `turn-${offset}`,
    responseId: `response-${offset}`,
    atMs: offset,
    dimensions: {
      sttProvider: "cartesia-ink-2",
      modelProvider: "cerebras",
      modelRoute: "llama-3.3-70b",
      ttsProvider: "cartesia-sonic",
      transport: "websocket",
      frameDurationMs: 20,
      sampleRateHz: 16_000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      inputDeviceClass: "builtin",
      outputDeviceClass: "builtin",
    },
  });
  const marks: [RealtimeVoiceTraceMark, number][] = [
    ["acoustic_speech_ended", 100],
    ["stt_final", 300],
    ["turn_committed", 310],
    ["llm_first_useful_text", 600],
    ["speakable_text_ready", 610],
    ["tts_first_byte", 700],
    ["first_audio_playout", 900],
    ["last_audio_playout", 1_200],
  ];
  for (const [mark, atMs] of marks) {
    trace = markRealtimeVoiceTrace(trace, mark, offset + atMs);
  }
  return finalize
    ? finalizeRealtimeVoiceTrace(trace, "spoken", offset + 1_210)
    : trace;
}

const completeSpokenTrace = (offset = 0) => spokenTrace(offset, true);

describe("realtime voice trace", () => {
  it("keeps only content-free, bounded cohort dimensions", () => {
    const trace = createRealtimeVoiceTrace({
      sessionId: "session-ok",
      turnId: "turn-ok",
      atMs: 0,
      dimensions: {
        sttProvider: "cartesia",
        modelProvider: `sk_${"A".repeat(24)}`,
        modelRoute: "route with user transcript",
        sampleRateHz: 44_100,
        inputDeviceClass: "usb",
        transcript: "never retain this",
        inputDeviceId: "raw-device-id",
      } as never,
      transcript: "also never retain this",
    } as never);
    const serialized = JSON.stringify(trace);
    expect(trace.dimensions.modelProvider).toBe("unknown");
    expect(trace.dimensions.modelRoute).toBe("unknown");
    expect(serialized).not.toContain("never retain this");
    expect(serialized).not.toContain("raw-device-id");
  });

  it("uses earliest first playout, latest last playout, and immutable first marks", () => {
    let trace = spokenTrace(0, false);
    trace = markRealtimeVoiceTrace(trace, "first_audio_playout", 850);
    trace = markRealtimeVoiceTrace(trace, "last_audio_playout", 1_250);
    trace = markRealtimeVoiceTrace(trace, "stt_final", 500);
    expect(trace.marks.first_audio_playout).toBe(850);
    expect(trace.marks.last_audio_playout).toBe(1_250);
    expect(trace.marks.stt_final).toBe(300);
    trace = finalizeRealtimeVoiceTrace(trace, "spoken", 1_260);
    expect(markRealtimeVoiceTrace(trace, "first_audio_playout", 800)).toBe(
      trace,
    );
  });

  it("reports complete measurement coverage and the configured latency SLOs", () => {
    const trace = completeSpokenTrace();
    expect(inspectRealtimeVoiceTraceCoverage(trace)).toMatchObject({
      complete: true,
      missingMarks: [],
    });
    const report = summarizeRealtimeVoiceLatency([trace]);
    expect(report.metrics.acoustic_end_to_stt_final).toMatchObject({
      count: 1,
      expectedCount: 1,
      p95Ms: 200,
      coveragePassed: true,
      sloPassed: true,
    });
    expect(report.metrics.acoustic_end_to_audible.p50Ms).toBe(800);
    expect(report.passed).toBe(true);
  });

  it("fails coverage when one eligible trace is missing a mark", () => {
    const complete = completeSpokenTrace();
    let partial = createRealtimeVoiceTrace({
      sessionId: "session-partial",
      turnId: "turn-partial",
      atMs: 0,
    });
    partial = markRealtimeVoiceTrace(partial, "acoustic_speech_ended", 100);
    partial = markRealtimeVoiceTrace(partial, "turn_committed", 200);
    partial = finalizeRealtimeVoiceTrace(partial, "error", 300);

    const report = summarizeRealtimeVoiceLatency([complete, partial]);
    expect(report.metrics.acoustic_end_to_stt_final).toMatchObject({
      count: 1,
      expectedCount: 2,
      coveragePassed: false,
      sloPassed: false,
    });
    expect(report.coveragePassed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails invalid negative durations instead of publishing a healthy latency", () => {
    let trace = createRealtimeVoiceTrace({
      sessionId: "session-negative",
      turnId: "turn-negative",
      atMs: 0,
      profiles: ["transcription"],
    });
    trace = markRealtimeVoiceTrace(trace, "acoustic_speech_ended", 200);
    trace = markRealtimeVoiceTrace(trace, "stt_final", 100);
    trace = finalizeRealtimeVoiceTrace(trace, "no_response", 300);
    expect(
      summarizeRealtimeVoiceLatency([trace]).metrics.acoustic_end_to_stt_final,
    ).toMatchObject({
      count: 0,
      expectedCount: 1,
      invalidCount: 1,
      coveragePassed: false,
    });
  });

  it("treats every stale audio frame as a hard release-gate failure", () => {
    let trace = completeSpokenTrace();
    trace = noteLateRealtimeVoiceAudioFrame(trace, 1_230);
    trace = noteLateRealtimeVoiceAudioFrame(trace, 1_240);
    const report = summarizeRealtimeVoiceLatency([trace]);
    expect(report.lateAudioFrames).toBe(2);
    expect(report.zeroLateAudioPassed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("requires interruption, reconnect, and mutation marks only when declared", () => {
    let trace = createRealtimeVoiceTrace({
      sessionId: "session-special",
      turnId: "turn-special",
      atMs: 0,
      profiles: ["interruption", "reconnect", "mutating_tool"],
    });
    trace = finalizeRealtimeVoiceTrace(trace, "interrupted", 10);
    expect(inspectRealtimeVoiceTraceCoverage(trace).missingMarks).toEqual(
      expect.arrayContaining([
        "local_speech_detected",
        "local_playback_paused",
        "server_interrupt_ack",
        "reconnect_started",
        "reconnect_ready",
        "turn_committed",
        "tool_mutation_committed",
      ]),
    );
  });

  it("never passes an empty or undersized cohort", () => {
    expect(summarizeRealtimeVoiceLatency([])).toMatchObject({
      traceCount: 0,
      completedTraceCount: 0,
      cohortSizePassed: false,
      completionPassed: false,
      passed: false,
    });
    expect(
      summarizeRealtimeVoiceLatency([completeSpokenTrace()], {
        minimumTraceCount: 2,
      }),
    ).toMatchObject({
      minimumTraceCount: 2,
      cohortSizePassed: false,
      passed: false,
    });
  });

  it("derives a nonempty expectation manifest instead of trusting all-false input", () => {
    const trace = createRealtimeVoiceTrace({
      sessionId: "session-manifest",
      turnId: "turn-manifest",
      atMs: 0,
      profiles: [],
    });
    expect(trace.profiles).toEqual(["spoken_response"]);
    expect(trace.expectations).toMatchObject({
      transcription: true,
      modelResponse: true,
      spokenResponse: true,
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.marks)).toBe(true);
  });

  it("does not let an open trace pass even if a caller records turn_ended", () => {
    let trace = spokenTrace(0, false);
    trace = markRealtimeVoiceTrace(trace, "turn_ended", 1_210);
    const report = summarizeRealtimeVoiceLatency([trace]);
    expect(inspectRealtimeVoiceTraceCoverage(trace)).toMatchObject({
      finalized: false,
      complete: false,
    });
    expect(report.completedTraceCount).toBe(0);
    expect(report.completionPassed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("seals normal marks at finalization and error outcomes cannot pass", () => {
    let trace = spokenTrace(0, false);
    trace = finalizeRealtimeVoiceTrace(trace, "error", 1_210);
    const after = markRealtimeVoiceTrace(trace, "stt_final", 350);
    expect(after).toBe(trace);
    expect(inspectRealtimeVoiceTraceCoverage(trace)).toMatchObject({
      finalized: true,
      outcomePassed: false,
      complete: false,
    });
    expect(summarizeRealtimeVoiceLatency([trace]).passed).toBe(false);

    const wrongOutcome = finalizeRealtimeVoiceTrace(
      spokenTrace(0, false),
      "no_response",
      1_210,
    );
    expect(inspectRealtimeVoiceTraceCoverage(wrongOutcome)).toMatchObject({
      outcomePassed: false,
      complete: false,
    });
  });

  it("rejects malformed runtime identities and outcomes instead of coercing them", () => {
    expect(() =>
      createRealtimeVoiceTrace({
        sessionId: 123,
        turnId: undefined,
        atMs: 0,
      } as never),
    ).toThrow("sessionId must be an opaque id");

    const valid = completeSpokenTrace();
    const malformed = { ...valid, outcome: "bogus" } as never;
    expect(summarizeRealtimeVoiceLatency([malformed])).toMatchObject({
      traceCount: 1,
      invalidTraceCount: 1,
      traceValidityPassed: false,
      passed: false,
    });

    const open = spokenTrace(0, false);
    expect(finalizeRealtimeVoiceTrace(open, "bogus" as never, 1_210)).toBe(
      open,
    );
  });

  it("enforces declared per-profile cohort minimums", () => {
    const report = summarizeRealtimeVoiceLatency([completeSpokenTrace()], {
      minimumProfileCounts: { spoken_response: 1, interruption: 1 },
    });
    expect(report.profileCounts.spoken_response).toBe(1);
    expect(report.profileCounts.interruption).toBe(0);
    expect(report.profileCoveragePassed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("rejects inconsistent late-frame state and malformed gate requirements", () => {
    const valid = completeSpokenTrace();
    const inconsistent = {
      ...valid,
      lateAudioFrames: 0,
      lastLateAudioFrameAtMs: 2_000,
    } as RealtimeVoiceTrace;
    expect(summarizeRealtimeVoiceLatency([inconsistent])).toMatchObject({
      invalidTraceCount: 1,
      traceValidityPassed: false,
      passed: false,
    });

    const malformedRequirements = summarizeRealtimeVoiceLatency([valid], {
      minimumTraceCount: Number.POSITIVE_INFINITY,
      minimumProfileCounts: { interruption: Number.POSITIVE_INFINITY },
    });
    expect(malformedRequirements.requirementsValid).toBe(false);
    expect(malformedRequirements.passed).toBe(false);

    const typoedRequirements = summarizeRealtimeVoiceLatency([valid], {
      minimumProfileCounts: { interupt: 99 },
    } as never);
    expect(typoedRequirements.requirementsValid).toBe(false);
    expect(typoedRequirements.passed).toBe(false);

    const nullRequirements = summarizeRealtimeVoiceLatency(
      [valid],
      null as never,
    );
    expect(nullRequirements.requirementsValid).toBe(false);
    expect(nullRequirements.passed).toBe(false);
  });
});
