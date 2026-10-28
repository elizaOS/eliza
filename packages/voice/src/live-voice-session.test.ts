import { describe, expect, it } from "vitest";
import {
  createLiveSegmentStream,
  createLiveVoiceSession,
  encodeLiveFrame,
  type LiveAudioFrame,
  type LiveFinal,
  type LiveVoiceLatency,
  type LiveVoiceTransport,
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
