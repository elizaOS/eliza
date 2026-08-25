/** Exercises voice trace behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import type { TraceService } from "../trace/trace-service";
import type {
  TraceEvent,
  TraceEventKind,
  TraceRecordEventParams,
  TraceSession,
  TraceStartSessionParams,
} from "../trace/types";
import type { VoiceLatencyMark, VoiceTurn } from "./types";
import {
  recordVoiceTraceStage,
  startVoiceTraceSession,
  type VoiceTraceStage,
  voiceTraceAutoOpen,
} from "./voice-trace";

const STAGE_KINDS: ReadonlyArray<readonly [VoiceTraceStage, TraceEventKind]> = [
  ["vad", "voice.vad"],
  ["turn-started", "voice.turn.started"],
  ["asr-partial", "voice.asr.partial"],
  ["asr-final", "voice.asr.final"],
  ["model-prepare-started", "model.prepare.started"],
  ["model-prepare-skipped", "model.prepare.skipped"],
  ["runtime-started", "model.request.started"],
  ["model-first-token", "model.first_token"],
  ["model-delta", "model.delta"],
  ["tts-started", "voice.tts.started"],
  ["tts-first-audio", "voice.tts.first_audio"],
  ["playback-started", "voice.playback.started"],
  ["latency-budget", "voice.latency.budget"],
  ["pipeline-error", "voice.pipeline.error"],
];

function voiceTurn(traceSessionId?: string): VoiceTurn {
  const turn: VoiceTurn = {
    id: "voice-turn-1",
    pipelineId: "voice-pipeline-1",
    status: "started",
    marks: [],
    createdAt: "2026-05-17T12:00:00.000Z",
    updatedAt: "2026-05-17T12:00:00.000Z",
  };
  if (traceSessionId !== undefined) {
    turn.traceSessionId = traceSessionId;
  }
  return turn;
}

function mark(options?: {
  durationMs?: number;
  offsetMs?: number;
}): VoiceLatencyMark {
  const next: VoiceLatencyMark = {
    stage: "vad",
    name: "vad",
    timestamp: "2026-05-17T12:00:00.010Z",
  };
  if (options?.durationMs !== undefined) {
    next.durationMs = options.durationMs;
  }
  if (options?.offsetMs !== undefined) {
    next.offsetMs = options.offsetMs;
  }
  return next;
}

function recordingService(): {
  service: TraceService;
  startSessionCalls: TraceStartSessionParams[];
  recordEventCalls: TraceRecordEventParams[];
  started: TraceSession;
} {
  const startSessionCalls: TraceStartSessionParams[] = [];
  const recordEventCalls: TraceRecordEventParams[] = [];
  const started: TraceSession = {
    id: "trace-session-1",
    title: "Voice turn",
    source: "voice",
    status: "running",
    runId: "voice-turn-1",
    createdAt: "2026-05-17T12:00:00.000Z",
    updatedAt: "2026-05-17T12:00:00.000Z",
  };
  const service = {
    async startSession(params: TraceStartSessionParams): Promise<TraceSession> {
      startSessionCalls.push(params);
      return started;
    },
    async recordEvent(params: TraceRecordEventParams): Promise<TraceEvent> {
      recordEventCalls.push(params);
      return {
        id: `event-${recordEventCalls.length}`,
        sessionId: params.sessionId,
        sequence: recordEventCalls.length,
        kind: params.kind,
        timestamp: "2026-05-17T12:00:00.000Z",
      };
    },
  } as TraceService;
  return { service, startSessionCalls, recordEventCalls, started };
}

describe("voiceTraceAutoOpen", () => {
  it("accepts 1, true, yes, and on after trim and lowercase", () => {
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "1" })).toBe(true);
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "true" })).toBe(
      true,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "yes" })).toBe(
      true,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "on" })).toBe(
      true,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: " TRUE " })).toBe(
      true,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "Yes" })).toBe(
      true,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "ON" })).toBe(
      true,
    );
  });

  it("rejects missing, blank, and other values", () => {
    expect(voiceTraceAutoOpen({})).toBe(false);
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: undefined })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "" })).toBe(false);
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "   " })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "0" })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "false" })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "off" })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "no" })).toBe(
      false,
    );
    expect(voiceTraceAutoOpen({ ELIZA_VOICE_TRACE_AUTO_OPEN: "enabled" })).toBe(
      false,
    );
    expect(
      voiceTraceAutoOpen({
        ELIZA_TRACE_AUTO_OPEN: "true",
        ELIZA_VOICE_TRACE_AUTO_OPEN: "false",
      }),
    ).toBe(false);
  });
});

describe("startVoiceTraceSession", () => {
  it("starts a voice session with pipeline and turn metadata", async () => {
    const { service, startSessionCalls, started } = recordingService();

    const session = await startVoiceTraceSession({
      traceService: service,
      title: "Voice turn",
      turnId: "voice-turn-1",
      pipelineId: "voice-pipeline-1",
      openView: false,
    });

    expect(session).toBe(started);
    expect(startSessionCalls).toEqual([
      {
        title: "Voice turn",
        source: "voice",
        runId: "voice-turn-1",
        metadata: {
          pipelineId: "voice-pipeline-1",
          turnId: "voice-turn-1",
        },
        openView: false,
      },
    ]);
  });

  it("forwards openView and merges extra metadata after built-in keys", async () => {
    const { service, startSessionCalls } = recordingService();

    await startVoiceTraceSession({
      traceService: service,
      title: "Override",
      turnId: "voice-turn-1",
      pipelineId: "voice-pipeline-1",
      openView: true,
      metadata: {
        pipelineId: "other-pipeline",
        turnId: "other-turn",
        extra: true,
      },
    });

    expect(startSessionCalls[0]).toEqual({
      title: "Override",
      source: "voice",
      runId: "voice-turn-1",
      metadata: {
        pipelineId: "other-pipeline",
        turnId: "other-turn",
        extra: true,
      },
      openView: true,
    });
  });

  it("uses an empty metadata object when extras are omitted", async () => {
    const { service, startSessionCalls } = recordingService();

    await startVoiceTraceSession({
      traceService: service,
      title: "Voice turn",
      turnId: "voice-turn-1",
      pipelineId: "voice-pipeline-1",
      openView: false,
    });

    expect(startSessionCalls[0]?.metadata).toEqual({
      pipelineId: "voice-pipeline-1",
      turnId: "voice-turn-1",
    });
    expect(Object.keys(startSessionCalls[0]?.metadata ?? {})).toEqual([
      "pipelineId",
      "turnId",
    ]);
  });
});

describe("recordVoiceTraceStage", () => {
  it("no-ops when the trace service is missing", async () => {
    await expect(
      recordVoiceTraceStage({
        traceService: null,
        turn: voiceTurn("trace-session-1"),
        stage: "vad",
        title: "VAD",
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when the turn has no trace session id", async () => {
    const { service, recordEventCalls } = recordingService();

    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn(),
      stage: "vad",
      title: "VAD",
    });
    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn(""),
      stage: "vad",
      title: "VAD",
    });

    expect(recordEventCalls).toEqual([]);
  });

  it("records every stage with the mapped kind, voice source, and turn run id", async () => {
    const { service, recordEventCalls } = recordingService();
    const turn = voiceTurn("trace-session-1");

    for (const [stage] of STAGE_KINDS) {
      await recordVoiceTraceStage({
        traceService: service,
        turn,
        stage,
        title: stage,
      });
    }

    expect(recordEventCalls.map((event) => event.kind)).toEqual(
      STAGE_KINDS.map(([, kind]) => kind),
    );
    expect(recordEventCalls).toHaveLength(STAGE_KINDS.length);
    for (const event of recordEventCalls) {
      expect(event.sessionId).toBe("trace-session-1");
      expect(event.source).toBe("voice");
      expect(event.runId).toBe("voice-turn-1");
      expect(event.timing).toBeUndefined();
    }
  });

  it("forwards text and payload and omits timing without a mark", async () => {
    const { service, recordEventCalls } = recordingService();

    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn("trace-session-1"),
      stage: "asr-final",
      title: "ASR final",
      text: "hello world",
      payload: { confidence: 0.9 },
    });

    expect(recordEventCalls).toEqual([
      {
        sessionId: "trace-session-1",
        kind: "voice.asr.final",
        title: "ASR final",
        text: "hello world",
        source: "voice",
        runId: "voice-turn-1",
        payload: { confidence: 0.9 },
        timing: undefined,
      },
    ]);
  });

  it("prefers mark durationMs over offsetMs, including a zero duration", async () => {
    const { service, recordEventCalls } = recordingService();

    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn("trace-session-1"),
      stage: "tts-first-audio",
      title: "First audio",
      mark: mark({ durationMs: 0, offsetMs: 40 }),
    });
    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn("trace-session-1"),
      stage: "playback-started",
      title: "Playback",
      mark: mark({ offsetMs: 25 }),
    });
    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn("trace-session-1"),
      stage: "latency-budget",
      title: "Budget",
      mark: mark(),
    });

    expect(recordEventCalls[0]?.timing).toEqual({
      startedAt: "2026-05-17T12:00:00.010Z",
      durationMs: 0,
    });
    expect(recordEventCalls[1]?.timing).toEqual({
      startedAt: "2026-05-17T12:00:00.010Z",
      durationMs: 25,
    });
    expect(recordEventCalls[2]?.timing).toEqual({
      startedAt: "2026-05-17T12:00:00.010Z",
      durationMs: undefined,
    });
  });

  it("records a whitespace session id because it is still a present string", async () => {
    const { service, recordEventCalls } = recordingService();

    await recordVoiceTraceStage({
      traceService: service,
      turn: voiceTurn(" "),
      stage: "pipeline-error",
      title: "Error",
    });

    expect(recordEventCalls).toHaveLength(1);
    expect(recordEventCalls[0]?.sessionId).toBe(" ");
    expect(recordEventCalls[0]?.kind).toBe("voice.pipeline.error");
  });
});
