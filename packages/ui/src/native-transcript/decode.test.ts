/**
 * Boundary-decoder unit tests: every field-level rejection reason, optional-field
 * validation, forward-compatible unknown-key tolerance, and the stream envelope
 * guards. Deterministic; no I/O.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_TRANSCRIPT_SCHEMA } from "./contract";
import { decodeTranscriptEvent, decodeTranscriptStream } from "./decode";

describe("decodeTranscriptEvent", () => {
  it("rejects non-objects with not-an-object", () => {
    for (const raw of [null, undefined, 42, "x", [], true]) {
      const res = decodeTranscriptEvent(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("not-an-object");
    }
  });

  it("requires a string `type`", () => {
    const res = decodeTranscriptEvent({ seq: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("missing-field");
      expect(res.error.field).toBe("type");
    }
  });

  it("rejects a missing, fractional, negative, or unsafe seq", () => {
    for (const seq of [undefined, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      const res = decodeTranscriptEvent({ type: "stt.partial", seq, turnId: "t", text: "" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("invalid-seq");
    }
  });

  it("rejects an unknown type", () => {
    const res = decodeTranscriptEvent({ type: "nope", seq: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown-type");
  });

  it("rejects an invalid optional `at`", () => {
    const res = decodeTranscriptEvent({ type: "reconnect", seq: 1, phase: "lost", attempt: 0, at: "soon" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe("at");
  });

  it("accepts an empty stt text but rejects a non-string one", () => {
    expect(decodeTranscriptEvent({ type: "stt.partial", seq: 1, turnId: "t", text: "" }).ok).toBe(true);
    const bad = decodeTranscriptEvent({ type: "stt.partial", seq: 1, turnId: "t", text: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe("text");
  });

  it("rejects malformed stt.final words", () => {
    const res = decodeTranscriptEvent({
      type: "stt.final",
      seq: 1,
      turnId: "t",
      text: "hi",
      words: [{ text: "hi", startMs: "0", endMs: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe("words");
  });

  it("rejects a non-boolean agent.text final", () => {
    const res = decodeTranscriptEvent({ type: "agent.text", seq: 1, messageId: "m", text: "hi", final: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.field).toBe("final");
  });

  it("rejects an invalid tool phase and an invalid audio phase", () => {
    expect(decodeTranscriptEvent({ type: "tool.state", seq: 1, callId: "c", name: "n", phase: "x" }).ok).toBe(false);
    expect(decodeTranscriptEvent({ type: "tts.audio", seq: 1, utteranceId: "u", phase: "paused" }).ok).toBe(false);
  });

  it("requires turnId for a turn-scoped cancel but not an all-scoped cancel", () => {
    expect(decodeTranscriptEvent({ type: "cancel", seq: 1, scope: "turn" }).ok).toBe(false);
    expect(decodeTranscriptEvent({ type: "cancel", seq: 1, scope: "all" }).ok).toBe(true);
    expect(decodeTranscriptEvent({ type: "cancel", seq: 1, scope: "turn", turnId: "t" }).ok).toBe(true);
  });

  it("ignores unknown keys (forward compatibility)", () => {
    const res = decodeTranscriptEvent({ type: "error", seq: 1, code: "e", retryable: true, futureField: {} });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event).toEqual({ type: "error", seq: 1, code: "e", retryable: true });
  });
});

describe("decodeTranscriptStream", () => {
  it("throws on an unusable envelope (not-object, wrong schema, non-array events)", () => {
    expect(() => decodeTranscriptStream(null)).toThrow();
    expect(() => decodeTranscriptStream({ schema: "other", events: [] })).toThrow();
    expect(() => decodeTranscriptStream({ schema: NATIVE_TRANSCRIPT_SCHEMA, events: {} })).toThrow();
  });

  it("keeps valid events and collects rejected ones with index + reason", () => {
    const res = decodeTranscriptStream({
      schema: NATIVE_TRANSCRIPT_SCHEMA,
      events: [
        { type: "stt.final", seq: 1, turnId: "t", text: "ok" },
        { type: "broken" },
        { type: "agent.text", seq: 3, messageId: "m", text: "hi", final: true },
      ],
    });
    expect(res.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].index).toBe(1);
  });
});
