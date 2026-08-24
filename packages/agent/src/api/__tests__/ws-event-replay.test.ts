/**
 * Unit tests for the WS reconnect cursor replay logic (loadperf research 05,
 * Finding 4). Exercises the pure helpers in isolation, asserting the
 * cursor-filtered slice AND the backward-compatible no-cursor fallback.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_LIMIT,
  eventSequence,
  parseEventCursor,
  type ReplayableEvent,
  selectReplayEvents,
} from "../ws-event-replay.ts";

function makeBuffer(count: number, startSeq = 1): ReplayableEvent[] {
  const out: ReplayableEvent[] = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    out.push({ eventId: `evt-${seq}`, bufferSeq: seq });
  }
  return out;
}

describe("parseEventCursor", () => {
  it("returns null for absent/empty/invalid cursors (falls back to slice)", () => {
    expect(parseEventCursor(null)).toBeNull();
    expect(parseEventCursor(undefined)).toBeNull();
    expect(parseEventCursor("")).toBeNull();
    expect(parseEventCursor("   ")).toBeNull();
    expect(parseEventCursor("not-a-number")).toBeNull();
    expect(parseEventCursor("garbage999")).toBeNull();
    expect(parseEventCursor("999garbage")).toBeNull();
    expect(parseEventCursor("evt-42-extra")).toBeNull();
    expect(parseEventCursor("evt--42")).toBeNull();
    expect(parseEventCursor("+42")).toBeNull();
    expect(parseEventCursor("42.5")).toBeNull();
  });

  it("parses a bare integer cursor", () => {
    expect(parseEventCursor("42")).toBe(42);
    expect(parseEventCursor("0")).toBe(0);
    expect(parseEventCursor("  7 ")).toBe(7);
  });

  it("parses a full evt-<n> cursor", () => {
    expect(parseEventCursor("evt-42")).toBe(42);
    expect(parseEventCursor("evt-0")).toBe(0);
  });
});

describe("eventSequence", () => {
  it("prefers numeric bufferSeq when present", () => {
    expect(eventSequence({ eventId: "evt-99", bufferSeq: 5 })).toBe(5);
  });

  it("falls back to the eventId numeric suffix when bufferSeq is absent", () => {
    expect(eventSequence({ eventId: "evt-77" })).toBe(77);
  });

  it("returns null for an unparseable eventId", () => {
    expect(eventSequence({ eventId: "no-digits-here" })).toBeNull();
  });
});

describe("selectReplayEvents — cursor present", () => {
  it("returns only events with seq strictly greater than the cursor", () => {
    const buffer = makeBuffer(10); // seq 1..10
    const result = selectReplayEvents(buffer, 7);
    expect(result.map((e) => e.bufferSeq)).toEqual([8, 9, 10]);
  });

  it("returns nothing when the cursor is at/after the newest event", () => {
    const buffer = makeBuffer(5); // seq 1..5
    expect(selectReplayEvents(buffer, 5)).toEqual([]);
    expect(selectReplayEvents(buffer, 100)).toEqual([]);
  });

  it("returns the whole buffer when the cursor predates everything", () => {
    const buffer = makeBuffer(4); // seq 1..4
    const result = selectReplayEvents(buffer, 0);
    expect(result.map((e) => e.bufferSeq)).toEqual([1, 2, 3, 4]);
  });

  it("caps a stale cursor's replay to the most-recent `limit` events", () => {
    const buffer = makeBuffer(500); // seq 1..500
    const result = selectReplayEvents(buffer, 0, 120);
    expect(result).toHaveLength(120);
    // capped to the newest 120 (seq 381..500), still in buffer order
    expect(result[0].bufferSeq).toBe(381);
    expect(result[result.length - 1].bufferSeq).toBe(500);
  });

  it("derives the sequence from eventId when bufferSeq is missing (REST-mirror events)", () => {
    const buffer: ReplayableEvent[] = [
      { eventId: "evt-1" },
      { eventId: "evt-2" },
      { eventId: "evt-3" },
    ];
    const result = selectReplayEvents(buffer, 1);
    expect(result.map((e) => e.eventId)).toEqual(["evt-2", "evt-3"]);
  });

  it("does not reorder or mutate the input buffer", () => {
    const buffer = makeBuffer(6);
    const snapshot = buffer.map((e) => e.bufferSeq);
    selectReplayEvents(buffer, 3);
    expect(buffer.map((e) => e.bufferSeq)).toEqual(snapshot);
  });
});

describe("selectReplayEvents — no cursor (backward compatible)", () => {
  it("returns slice(-DEFAULT_REPLAY_LIMIT) for a null cursor, identical to legacy behavior", () => {
    const buffer = makeBuffer(300); // seq 1..300
    const legacy = buffer.slice(-DEFAULT_REPLAY_LIMIT);
    const result = selectReplayEvents(buffer, null);
    expect(result).toEqual(legacy);
    expect(result).toHaveLength(DEFAULT_REPLAY_LIMIT);
    expect(result[0].bufferSeq).toBe(300 - DEFAULT_REPLAY_LIMIT + 1);
    expect(result[result.length - 1].bufferSeq).toBe(300);
  });

  it("returns the whole buffer (slice tail) when shorter than the limit", () => {
    const buffer = makeBuffer(5);
    const result = selectReplayEvents(buffer, null);
    expect(result).toEqual(buffer);
    expect(result).not.toBe(buffer); // a copy, not the original reference
  });

  it("matches the exact legacy slice(-120) for an invalid cursor string", () => {
    const buffer = makeBuffer(200);
    const cursor = parseEventCursor("garbage"); // -> null
    const result = selectReplayEvents(buffer, cursor);
    expect(result).toEqual(buffer.slice(-120));
  });
});

describe("selectReplayEvents — fail-closed on non-positive limit", () => {
  it("returns [] for limit=0, negative, and NaN with no cursor", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, null, 0)).toEqual([]);
    expect(selectReplayEvents(buffer, null, -5)).toEqual([]);
    expect(selectReplayEvents(buffer, null, NaN)).toEqual([]);
  });

  it("returns [] for limit=0, negative, and NaN with a cursor", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, 5, 0)).toEqual([]);
    expect(selectReplayEvents(buffer, 5, -1)).toEqual([]);
    expect(selectReplayEvents(buffer, 5, NaN)).toEqual([]);
  });

  it("returns [] for sub-unit and non-finite limits", () => {
    const buffer = makeBuffer(20);
    for (const limit of [0.5, Number.POSITIVE_INFINITY]) {
      expect(selectReplayEvents(buffer, null, limit)).toEqual([]);
      expect(selectReplayEvents(buffer, 5, limit)).toEqual([]);
    }
  });

  it("floors a positive fractional limit before slicing", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, null, 1.9)).toEqual(buffer.slice(-1));
    expect(selectReplayEvents(buffer, 5, 1.9)).toEqual([buffer.at(-1)]);
  });
});

describe("eventSequence — invalid bufferSeq falls back to eventId", () => {
  it("ignores a negative bufferSeq and parses the eventId instead", () => {
    expect(eventSequence({ eventId: "evt-9", bufferSeq: -1 })).toBe(9);
  });

  it("ignores a fractional bufferSeq", () => {
    expect(eventSequence({ eventId: "evt-9", bufferSeq: 2.5 })).toBe(9);
  });

  it("ignores an unsafe bufferSeq above MAX_SAFE_INTEGER", () => {
    expect(
      eventSequence({
        eventId: "evt-4",
        bufferSeq: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(4);
  });
});

describe("eventSequence — eventId parse edges", () => {
  it("parses digits followed by trailing whitespace", () => {
    expect(eventSequence({ eventId: "evt-7  " })).toBe(7);
  });

  it("uses the last digit run when the id has interleaved text", () => {
    expect(eventSequence({ eventId: "batch12-run34" })).toBe(34);
  });

  it("returns null when the parsed sequence exceeds MAX_SAFE_INTEGER", () => {
    expect(eventSequence({ eventId: "evt-99999999999999999999" })).toBeNull();
  });

  it("returns null for the bare prefix evt-", () => {
    expect(eventSequence({ eventId: "evt-" })).toBeNull();
  });
});

describe("parseEventCursor — numeric bounds", () => {
  it("accepts exactly MAX_SAFE_INTEGER in both cursor forms", () => {
    expect(parseEventCursor("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseEventCursor("evt-9007199254740991")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("returns null for cursors beyond MAX_SAFE_INTEGER", () => {
    expect(parseEventCursor("9007199254740992")).toBeNull();
    expect(parseEventCursor("evt-99999999999999999999")).toBeNull();
  });

  it("parses zero-padded cursors as their integer value", () => {
    expect(parseEventCursor("007")).toBe(7);
  });
});

describe("selectReplayEvents — unsequenceable envelopes under a cursor", () => {
  it("skips envelopes with no derivable sequence instead of failing or leaking them", () => {
    const buffer: ReplayableEvent[] = [
      { eventId: "evt-a" },
      { eventId: "evt-2" },
      { eventId: "no-sequence" },
      { eventId: "evt-3" },
    ];
    const result = selectReplayEvents(buffer, 1);
    expect(result.map((e) => e.eventId)).toEqual(["evt-2", "evt-3"]);
  });
});

describe("selectReplayEvents — tied sequences", () => {
  it("replays every envelope past the cursor, including duplicates, in buffer order", () => {
    const buffer: ReplayableEvent[] = [
      { eventId: "evt-1", bufferSeq: 1 },
      { eventId: "evt-2a", bufferSeq: 2 },
      { eventId: "evt-2b", bufferSeq: 2 },
      { eventId: "evt-3", bufferSeq: 3 },
    ];
    const result = selectReplayEvents(buffer, 1);
    expect(result.map((e) => e.eventId)).toEqual(["evt-2a", "evt-2b", "evt-3"]);
  });
});

describe("selectReplayEvents — cap boundary under a cursor", () => {
  it("returns all missing events unsliced when they exactly equal the cap", () => {
    const buffer = makeBuffer(10); // seq 1..10
    const result = selectReplayEvents(buffer, 4, 6); // missing 5..10 == cap
    expect(result.map((e) => e.bufferSeq)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("keeps only the newest cap events when missing exceeds the cap by one", () => {
    const buffer = makeBuffer(10);
    const result = selectReplayEvents(buffer, 3, 6); // missing 4..10 = 7 > 6
    expect(result.map((e) => e.bufferSeq)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("leaves the input buffer untouched after a capped replay", () => {
    const buffer = makeBuffer(12);
    const snapshot = [...buffer];
    selectReplayEvents(buffer, 0, 5);
    expect(buffer).toEqual(snapshot);
    expect(buffer).toHaveLength(12);
  });
});

describe("selectReplayEvents — explicit non-default limit without a cursor", () => {
  it("returns tail slice(-limit) for an explicit limit below the buffer size", () => {
    const buffer = makeBuffer(10);
    const result = selectReplayEvents(buffer, null, 3);
    expect(result.map((e) => e.bufferSeq)).toEqual([8, 9, 10]);
  });

  it("returns a full ordered copy when the limit covers the whole buffer", () => {
    const buffer = makeBuffer(4);
    const result = selectReplayEvents(buffer, null, 10);
    expect(result).toEqual(buffer);
    expect(result).not.toBe(buffer);
  });
});
