import { describe, expect, it, vi } from "vitest";
import {
  createLiveDictation,
  createLiveSegmentStream,
  createLiveVoiceSession,
  encodeLiveFrame,
  type LiveAudioFrame,
  type LiveCaptureOpenOptions,
  type LiveCaptureStream,
  type LiveFinal,
  type LiveVoiceLatency,
  type LiveVoiceTransport,
  liveAssistantListener,
  parseLiveFinal,
  parseVoiceTranscriptEnvelope,
} from "./live-voice-session";

// Contract of the live ASR client against a stub agent that speaks the wire format of
// POST /api/asr/local-inference/live and the ephemeral voice-transcript agent_event stream.
// Not microphone, recognition or latency evidence.
type Body = Record<string, unknown> & {
  sessionId?: string;
  roomId?: string;
  close?: boolean;
  frames?: LiveAudioFrame[];
  vad?: { type: string; timestampMs: number }[];
};
type Reply = (body: Body, next: () => string) => unknown;

function stubAgent() {
  const posts: Body[] = [];
  let listener: ((envelope: unknown) => void) | undefined;
  let reply: Reply = () => ({ ok: true, mode: "stream", framesReceived: 0 });
  let turn = 0;
  return {
    posts,
    setReply(next: Reply) {
      reply = next;
    },
    transport: {
      post: async (body: Record<string, unknown>) => {
        posts.push(structuredClone(body) as Body);
        return reply(body as Body, () => `t${++turn}`);
      },
      subscribe: (fn: (envelope: unknown) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } satisfies LiveVoiceTransport,
    emit: (payload: Record<string, unknown>) =>
      listener?.({
        type: "agent_event",
        version: 1,
        ephemeral: true,
        eventId: "eph-1",
        stream: "voice-transcript",
        ts: 1,
        runId: "r",
        seq: 1,
        payload: { type: "voice-transcript", ...payload },
      }),
    get subscribed() {
      return listener !== undefined;
    },
  };
}
/** A request-only transport (no event stream). */
function postOnly(reply: Reply) {
  const posts: Body[] = [];
  let turn = 0;
  return {
    posts,
    setReply(next: Reply) {
      reply = next;
    },
    transport: {
      post: async (body: Record<string, unknown>) => {
        posts.push(structuredClone(body) as Body);
        return reply(body as Body, () => `t${++turn}`);
      },
    } satisfies LiveVoiceTransport,
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const failure = (status: number, code?: string) =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    ...(code ? { data: { code } } : {}),
  });
const speechEnd = (body: Body) =>
  !!body.vad?.some((edge) => edge.type === "speech-end");
const frame = (timestamp = 1) =>
  encodeLiveFrame(new Float32Array(512).fill(0.1), timestamp);
const small = (timestamp: number): LiveAudioFrame => ({
  pcm16: "AAAA",
  sampleRate: 16000,
  channels: 1,
  samples: 2,
  timestamp,
});
const finalOn: Reply = (body, next) =>
  speechEnd(body)
    ? {
        ok: true,
        mode: "stream",
        framesReceived: 1,
        final: {
          turnId: next(),
          text: `heard ${body.frames?.length ?? 0} frames`,
          mode: "stream",
          asrFinalFromSpeechEndMs: 20,
        },
      }
    : { ok: true, mode: "stream", framesReceived: 1 };

describe("live voice session", () => {
  it("forwards frames and VAD edges in order with the upstream frame wire format", async () => {
    const agent = stubAgent();
    const session = createLiveVoiceSession({
      transport: agent.transport,
      roomId: "room-1",
    });
    expect(session.sessionId).toMatch(/^live-/);
    expect(session.sessionId.length).toBeLessThanOrEqual(128);
    await session.push(
      [frame(1), frame(2)],
      [{ type: "speech-start", timestampMs: 1 }],
    );
    await session.push([frame(3)], [{ type: "speech-end", timestampMs: 3 }]);
    expect(agent.posts.map((body) => body.vad?.[0]?.type)).toEqual([
      "speech-start",
      "speech-end",
    ]);
    for (const body of agent.posts) {
      expect(body.sessionId).toBe(session.sessionId);
      expect(body.roomId).toBe("room-1");
    }
    const first = agent.posts[0]?.frames?.[0];
    expect([first?.sampleRate, first?.channels, first?.samples]).toEqual([
      16000, 1, 512,
    ]);
    const bytes = Uint8Array.from(atob(first?.pcm16 ?? ""), (c) =>
      c.charCodeAt(0),
    );
    expect(bytes.length).toBe(1024);
    expect(new DataView(bytes.buffer).getInt16(0, true)).toBe(
      Math.round(0.1 * 32767),
    );
    session.dispose();
    expect(agent.subscribed).toBe(false);
  });

  it("replaces interim text, drops stale turns and other sessions, and delivers a final once", async () => {
    const agent = stubAgent();
    let now = 1000;
    const interim: string[] = [];
    const finals: { final: LiveFinal; latency: LiveVoiceLatency }[] = [];
    const session = createLiveVoiceSession({
      transport: agent.transport,
      now: () => now,
      onInterim: (text) => interim.push(text),
      onFinal: (final, latency) => finals.push({ final, latency }),
    });
    const sessionId = session.sessionId;
    await session.push([frame()], [{ type: "speech-start", timestampMs: 1 }]);
    agent.emit({ sessionId, turnId: "t1", phase: "speech-start" });
    now = 1180;
    agent.emit({
      sessionId,
      turnId: "t1",
      phase: "partial",
      text: "remind me",
      seq: 1,
    });
    agent.emit({
      sessionId,
      turnId: "t1",
      phase: "partial",
      text: "remind me to",
      seq: 2,
    });
    agent.emit({
      sessionId,
      turnId: "t1",
      phase: "partial",
      text: "stale seq",
      seq: 2,
    });
    agent.emit({
      sessionId,
      turnId: "t0",
      phase: "partial",
      text: "old turn",
      seq: 9,
    });
    agent.emit({
      sessionId: "someone-else",
      turnId: "t1",
      phase: "partial",
      text: "not ours",
      seq: 3,
    });
    expect(interim).toEqual(["remind me", "remind me to"]);
    expect(session.interim()).toBe("remind me to");
    now = 2000;
    agent.setReply(() => ({
      ok: true,
      mode: "stream",
      framesReceived: 3,
      final: {
        turnId: "t1",
        text: " remind me to call Sam ",
        mode: "stream",
        asrFinalFromSpeechEndMs: 140,
      },
    }));
    await session.push([frame()], [{ type: "speech-end", timestampMs: 2 }]);
    now = 2170;
    agent.emit({
      sessionId,
      turnId: "t1",
      phase: "final",
      text: "remind me to call Sam",
      mode: "stream",
      asrFinalFromSpeechEndMs: 140,
    });
    agent.emit({
      sessionId,
      turnId: "t1",
      phase: "partial",
      text: "late partial",
      seq: 5,
    });
    expect(finals).toHaveLength(1);
    expect(finals[0]?.final.text).toBe("remind me to call Sam");
    expect(finals[0]?.latency).toEqual({
      mode: "stream",
      partials: 2,
      firstPartialMs: 180,
      finalFromSpeechEndMs: 0,
      asrFinalFromSpeechEndMs: 140,
    });
    expect(interim.at(-1)).toBe("");
    expect(session.interim()).toBe("");
    agent.emit({ sessionId, turnId: "t2", phase: "speech-start" });
    agent.emit({
      sessionId,
      turnId: "t2",
      phase: "partial",
      text: "and",
      seq: 1,
    });
    expect(session.interim()).toBe("and");
    agent.emit({
      sessionId,
      turnId: "t2",
      phase: "error",
      code: "ASR_FAILED",
    });
    expect(session.interim()).toBe("");
    session.dispose();
  });

  it("takes the final from the HTTP response alone on a request-only transport", async () => {
    const agent = postOnly((body) =>
      speechEnd(body)
        ? {
            ok: true,
            mode: "batch",
            framesReceived: 2,
            final: {
              turnId: "turn-a",
              text: "hello",
              mode: "batch",
              asrFinalFromSpeechEndMs: 300,
            },
          }
        : { ok: true, mode: "batch", framesReceived: 1 },
    );
    const session = createLiveVoiceSession({ transport: agent.transport });
    const next = session.nextFinal();
    await session.push([frame()], [{ type: "speech-start", timestampMs: 1 }]);
    await session.push([frame()], [{ type: "speech-end", timestampMs: 2 }]);
    expect(await next).toEqual({
      turnId: "turn-a",
      text: "hello",
      mode: "batch",
      asrFinalFromSpeechEndMs: 300,
    });
    await session.close();
    expect(agent.posts.at(-1)?.close).toBe(true);
    expect(await session.nextFinal()).toBeNull();
  });

  it("settles a waiting turn without text when the route is unavailable", async () => {
    const errors: string[] = [];
    const session = createLiveVoiceSession({
      transport: {
        post: async () => {
          throw failure(503);
        },
      },
      onError: (code) => errors.push(code),
    });
    const next = session.nextFinal();
    await session.push([frame()], [{ type: "speech-start", timestampMs: 1 }]);
    expect(await next).toBeNull();
    expect(errors).toEqual(["LIVE_ASR_UNAVAILABLE"]);
    session.dispose();
  });

  it("ignores malformed envelopes and finals", () => {
    const id = "live-x";
    expect(
      parseVoiceTranscriptEnvelope(
        { type: "agent_event", stream: "voice-control", payload: {} },
        id,
      ),
    ).toBeUndefined();
    const partial = (extra: Record<string, unknown>) => ({
      type: "agent_event",
      stream: "voice-transcript",
      payload: {
        type: "voice-transcript",
        sessionId: id,
        turnId: "t",
        phase: "partial",
        ...extra,
      },
    });
    expect(
      parseVoiceTranscriptEnvelope(partial({ text: "x", seq: 0 }), id),
    ).toBeUndefined();
    expect(
      parseVoiceTranscriptEnvelope(
        partial({ text: "x".repeat(16001), seq: 1 }),
        id,
      ),
    ).toBeUndefined();
    expect(
      parseVoiceTranscriptEnvelope(partial({ text: "x", seq: 1 }), "other"),
    ).toBeUndefined();
    expect(parseLiveFinal({ turnId: "", text: "x" })).toBeUndefined();
    expect(
      parseLiveFinal({
        turnId: "t",
        text: "x",
        mode: "weird",
        asrFinalFromSpeechEndMs: -1,
      }),
    ).toEqual({
      turnId: "t",
      text: "x",
      mode: "unknown",
      asrFinalFromSpeechEndMs: null,
    });
  });
});

describe("live segment stream", () => {
  it("never forwards audio after the stop and ends the open segment at the stop", async () => {
    const agent = postOnly(finalOn);
    const segments: (string | null)[] = [];
    const ends: number[] = [];
    const stream = createLiveSegmentStream({
      transport: agent.transport,
      onSegment: (text) => segments.push(text),
      onSpeechEnd: (at) => ends.push(at),
    });
    await stream.accept(
      [small(100), small(132)],
      [{ type: "speech-start", timestampMs: 100 }],
    );
    expect(stream.speaking()).toBe(true);
    stream.cutoff(150);
    // In flight from the native thread: one frame before the stop, one after, and a late edge.
    await stream.accept(
      [small(140), small(170)],
      [{ type: "speech-end", timestampMs: 180 }],
    );
    await stream.close();
    expect(ends).toEqual([150]);
    expect(
      agent.posts
        .flatMap((body) => body.frames ?? [])
        .map((entry) => entry.timestamp),
    ).toEqual([100, 132, 140]);
    const closing = agent.posts.filter(speechEnd);
    expect(closing).toHaveLength(1);
    expect(closing[0]?.vad?.[0]?.timestampMs).toBe(150);
    expect(segments).toHaveLength(1);
    expect(agent.posts.at(-1)?.close).toBe(true);
  });

  it("yields null for an ASR_FAILED segment and continues; a bare 502 is a transport failure", async () => {
    let failNext = true;
    const agent = postOnly((body, next) => {
      if (!speechEnd(body))
        return { ok: true, mode: "stream", framesReceived: 1 };
      if (failNext) {
        failNext = false;
        return Promise.reject(failure(502, "ASR_FAILED"));
      }
      return finalOn(body, next);
    });
    const segments: (string | null)[] = [];
    const fatal: string[] = [];
    const stream = createLiveSegmentStream({
      transport: agent.transport,
      onSegment: (text) => segments.push(text),
      onFatal: (code) => fatal.push(code),
    });
    await stream.accept([small(1)], [{ type: "speech-start", timestampMs: 1 }]);
    await stream.accept([small(2)], [{ type: "speech-end", timestampMs: 2 }]);
    await stream.accept([small(3)], [{ type: "speech-start", timestampMs: 3 }]);
    await stream.accept([small(4)], [{ type: "speech-end", timestampMs: 4 }]);
    expect(segments).toEqual([null, "heard 1 frames"]);
    expect(fatal).toEqual([]);
    agent.setReply((body) =>
      speechEnd(body) ? Promise.reject(failure(502)) : { ok: true },
    );
    await stream.accept([small(5)], [{ type: "speech-start", timestampMs: 5 }]);
    await stream.accept([small(6)], [{ type: "speech-end", timestampMs: 6 }]);
    expect(fatal).toEqual(["TRANSPORT"]);
  });

  it("gives one result per closed segment, treats 503 as fatal and discards after cancel", async () => {
    const down = postOnly((body) =>
      speechEnd(body)
        ? Promise.reject(failure(503))
        : { ok: true, mode: "stream", framesReceived: 1 },
    );
    const segments: (string | null)[] = [];
    const fatal: string[] = [];
    const stream = createLiveSegmentStream({
      transport: down.transport,
      onSegment: (text) => segments.push(text),
      onFatal: (code) => fatal.push(code),
    });
    await stream.accept([small(1)], [{ type: "speech-start", timestampMs: 1 }]);
    await stream.accept([small(2)], [{ type: "speech-end", timestampMs: 2 }]);
    expect(segments).toEqual([null]);
    expect(fatal).toEqual(["LIVE_ASR_UNAVAILABLE"]);

    const quiet = postOnly(finalOn);
    const results: (string | null)[] = [];
    const discarded = createLiveSegmentStream({
      transport: quiet.transport,
      onSegment: (text) => results.push(text),
    });
    await discarded.accept(
      [small(1)],
      [{ type: "speech-start", timestampMs: 1 }],
    );
    discarded.cancel();
    await discarded.accept(
      [small(2)],
      [{ type: "speech-end", timestampMs: 2 }],
    );
    await flush();
    expect(results).toEqual([]);
    expect(
      quiet.posts.every(
        (body) => !(body.frames ?? []).some((entry) => entry.timestamp === 2),
      ),
    ).toBe(true);
  });

  it("counts a failed turn reported by both its error event and its 502 response once", async () => {
    let listener: ((envelope: unknown) => void) | undefined;
    const results: (string | null)[] = [];
    const stream = createLiveSegmentStream({
      transport: {
        post: async (body: Record<string, unknown>) =>
          speechEnd(body as Body)
            ? Promise.reject(failure(502, "ASR_FAILED"))
            : { ok: true },
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
      },
      onSegment: (text) => results.push(text),
    });
    const sessionId = stream.sessionId;
    const event = (payload: Record<string, unknown>) =>
      listener?.({
        type: "agent_event",
        stream: "voice-transcript",
        payload: { type: "voice-transcript", sessionId, ...payload },
      });
    await stream.accept([small(1)], [{ type: "speech-start", timestampMs: 1 }]);
    event({ turnId: "t1", phase: "speech-start" });
    const closing = stream.accept(
      [small(2)],
      [{ type: "speech-end", timestampMs: 2 }],
    );
    event({ turnId: "t1", phase: "error" });
    await closing;
    await stream.accept([small(3)], [{ type: "speech-start", timestampMs: 3 }]);
    expect(results).toEqual([null]);
  });

  it("yields one null per failed segment even when the next speech starts before the 502", async () => {
    const pending: (() => void)[] = [];
    const results: (string | null)[] = [];
    const stream = createLiveSegmentStream({
      transport: {
        post: (body: Record<string, unknown>) =>
          speechEnd(body as Body)
            ? new Promise((_, reject) =>
                pending.push(() => reject(failure(502, "ASR_FAILED"))),
              )
            : Promise.resolve({ ok: true }),
      },
      onSegment: (text) => results.push(text),
    });
    void stream.accept([small(1)], [{ type: "speech-start", timestampMs: 1 }]);
    void stream.accept([small(2)], [{ type: "speech-end", timestampMs: 2 }]);
    await flush();
    void stream.accept([small(3)], [{ type: "speech-start", timestampMs: 3 }]);
    pending.shift()?.();
    await flush();
    void stream.accept([small(4)], [{ type: "speech-end", timestampMs: 4 }]);
    await flush();
    pending.shift()?.();
    await flush();
    expect(results).toEqual([null, null]);
  });
});

/** A host capture that records how it was opened and lets the test drive its callbacks. */
function fakeOpener() {
  const opened: LiveCaptureOpenOptions[] = [];
  const closes: (number | undefined)[] = [];
  let cancels = 0;
  let segmentsOnClose: string[] = [];
  const open = async (
    input: LiveCaptureOpenOptions,
  ): Promise<LiveCaptureStream> => {
    opened.push(input);
    return {
      startedAt: 1000,
      echoCancelled: input.echoCancel,
      speaking: () => false,
      async close(at) {
        closes.push(at);
        for (const text of segmentsOnClose) input.onSegment(text);
        return { durationMs: 1234 };
      },
      async cancel() {
        cancels++;
      },
    };
  };
  return {
    open,
    opened,
    closes,
    get cancels() {
      return cancels;
    },
    finalOnClose(texts: string[]) {
      segmentsOnClose = texts;
    },
  };
}

describe("live dictation over a host capture", () => {
  it("opens without echo cancellation, finalizes up to Stop and returns an editable draft", async () => {
    const host = fakeOpener();
    const latencies: unknown[] = [];
    const dictation = createLiveDictation(host.open, {
      roomId: "room-1",
      onLatency: (latency) => latencies.push(latency),
    });
    const { recordingId } = await dictation.startRecording();
    expect(host.opened[0]?.echoCancel).toBe(false);
    expect(host.opened[0]?.roomId).toBe("room-1");
    await expect(dictation.startRecording()).rejects.toThrow(
      "already recording",
    );
    host.opened[0]?.onSegment("hello", {
      asrFinalFromSpeechEndMs: 40,
    } as LiveVoiceLatency);
    host.finalOnClose(["  world  "]);
    const clip = await dictation.stopRecording();
    expect(clip).toEqual({ recordingId, durationMs: 1234 });
    expect(typeof host.closes[0]).toBe("number");
    expect(latencies).toHaveLength(1);
    const controller = new AbortController();
    await expect(
      dictation.transcribe(recordingId, controller.signal),
    ).resolves.toEqual({ text: "hello world", local: true });
    await expect(
      dictation.transcribe("live:other", controller.signal),
    ).rejects.toThrow("no longer available");
  });

  it("reports no speech, discards on cancel and reports a lost capture once", async () => {
    const host = fakeOpener();
    const dictation = createLiveDictation(host.open);
    const silent = await dictation.startRecording();
    await dictation.stopRecording();
    await expect(
      dictation.transcribe(silent.recordingId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "no-speech" });

    const discarded = await dictation.startRecording();
    host.opened[1]?.onSegment("private");
    await dictation.cancelRecording();
    expect(host.cancels).toBe(1);
    expect(host.opened[1]?.signal.aborted).toBe(true);
    await expect(
      dictation.transcribe(discarded.recordingId, new AbortController().signal),
    ).rejects.toThrow("no longer available");

    const stopped: { recordingId: string; durationMs: number }[] = [];
    await dictation.addListener("recordingStopped", (clip) =>
      stopped.push(clip),
    );
    const lost = await dictation.startRecording();
    host.opened[2]?.onLost(new Error("mic"));
    host.opened[2]?.onLost(new Error("again"));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.recordingId).toBe(lost.recordingId);
    expect(Number.isNaN(stopped[0]?.durationMs)).toBe(true);
    // Transcribe can start again after a lost capture.
    await expect(dictation.startRecording()).resolves.toBeTruthy();
  });

  it("stops by itself at the duration limit", async () => {
    vi.useFakeTimers();
    try {
      const host = fakeOpener();
      const dictation = createLiveDictation(host.open, { maxDurationMs: 1000 });
      const stopped: { recordingId: string; durationMs: number }[] = [];
      await dictation.addListener("recordingStopped", (clip) =>
        stopped.push(clip),
      );
      const { recordingId, maxDurationMs } = await dictation.startRecording();
      expect(maxDurationMs).toBe(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(stopped).toEqual([{ recordingId, durationMs: 1234 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assistant listen port over a host capture", () => {
  it("opens echo-cancelled, forwards segments, latency and loss, and is full duplex only with a canceller", async () => {
    const host = fakeOpener();
    const latencies: unknown[] = [];
    const interims: string[] = [];
    const listen = liveAssistantListener(host.open, {
      onLatency: (latency) => latencies.push(latency),
      onInterim: (text) => interims.push(text),
    });
    const events: unknown[] = [];
    const controller = new AbortController();
    const capture = await listen({
      signal: controller.signal,
      onSpeechStart: (at) => events.push(["start", at]),
      onSpeechEnd: (at) => events.push(["end", at]),
      onSegment: (text) => events.push(["segment", text]),
      onEnd: (error) => events.push(["lost", (error as Error).message]),
      onLevel: (peak) => events.push(["level", peak]),
    });
    const input = host.opened[0] as LiveCaptureOpenOptions;
    expect(input.echoCancel).toBe(true);
    expect(input.signal).toBe(controller.signal);
    expect(capture.fullDuplex).toBe(true);
    input.onSpeechStart?.(5);
    input.onSegment("hi", { asrFinalFromSpeechEndMs: 10 } as LiveVoiceLatency);
    input.onSegment(null);
    input.onInterim?.("h");
    input.onLevel?.(0.5);
    input.onSpeechEnd?.(9);
    input.onLost(new Error("gone"));
    expect(events).toEqual([
      ["start", 5],
      ["segment", "hi"],
      ["segment", null],
      ["level", 0.5],
      ["end", 9],
      ["lost", "gone"],
    ]);
    expect(latencies).toHaveLength(1);
    expect(interims).toEqual(["h"]);
    await capture.close();
    expect(host.closes).toEqual([undefined]);
    await capture.cancel();
    expect(host.cancels).toBe(1);
  });
});
