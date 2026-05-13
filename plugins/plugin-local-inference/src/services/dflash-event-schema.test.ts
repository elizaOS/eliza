import { describe, expect, it } from "vitest";
import {
  computeAcceptanceRate,
  type DflashStreamEvent,
  type DflashVerifyStreamEvent,
  dflashBatchEventSchema,
  expandDflashBatchEvent,
  groupByRound,
  parseDflashBatchEvent,
  parseDflashFieldFromSseChunk,
  parseDflashStreamEvent,
  summarizeEvents,
} from "./dflash-event-schema";

describe("parseDflashStreamEvent", () => {
  it("parses a well-formed accept event", () => {
    const ev = parseDflashStreamEvent({
      kind: "accept",
      drafted: [10, 20, 30],
      accepted: [10, 20],
      ts: 12345,
    });
    expect(ev).toEqual({
      kind: "accept",
      drafted: [10, 20, 30],
      accepted: [10, 20],
      ts: 12345,
    });
  });

  it("parses a well-formed reject event", () => {
    const ev = parseDflashStreamEvent({
      kind: "reject",
      drafted: [5, 6, 7],
      rejectRange: [3, 5],
      correctedToken: 99,
      ts: 1,
    });
    expect(ev).toEqual({
      kind: "reject",
      drafted: [5, 6, 7],
      rejectRange: [3, 5],
      correctedToken: 99,
      ts: 1,
    });
  });

  it("parses speculate-start / speculate-end events", () => {
    expect(
      parseDflashStreamEvent({ kind: "speculate-start", round: 4, ts: 100 }),
    ).toEqual({ kind: "speculate-start", round: 4, ts: 100 });
    expect(
      parseDflashStreamEvent({
        kind: "speculate-end",
        round: 4,
        totalDrafted: 10,
        totalAccepted: 8,
        ts: 200,
      }),
    ).toEqual({
      kind: "speculate-end",
      round: 4,
      totalDrafted: 10,
      totalAccepted: 8,
      ts: 200,
    });
  });

  it("rejects malformed events", () => {
    expect(parseDflashStreamEvent(null)).toBeNull();
    expect(parseDflashStreamEvent(undefined)).toBeNull();
    expect(parseDflashStreamEvent("nope")).toBeNull();
    expect(parseDflashStreamEvent({})).toBeNull();
    // Missing ts
    expect(
      parseDflashStreamEvent({ kind: "accept", drafted: [], accepted: [] }),
    ).toBeNull();
    // accepted longer than drafted
    expect(
      parseDflashStreamEvent({
        kind: "accept",
        drafted: [1],
        accepted: [1, 2],
        ts: 0,
      }),
    ).toBeNull();
    // Inverted reject range
    expect(
      parseDflashStreamEvent({
        kind: "reject",
        drafted: [1],
        rejectRange: [3, 2],
        correctedToken: 0,
        ts: 0,
      }),
    ).toBeNull();
    // Negative tokens
    expect(
      parseDflashStreamEvent({
        kind: "accept",
        drafted: [-1],
        accepted: [],
        ts: 0,
      }),
    ).toBeNull();
    // totalAccepted > totalDrafted
    expect(
      parseDflashStreamEvent({
        kind: "speculate-end",
        round: 0,
        totalDrafted: 1,
        totalAccepted: 2,
        ts: 0,
      }),
    ).toBeNull();
    // Unknown kind
    expect(parseDflashStreamEvent({ kind: "bogus", ts: 0 })).toBeNull();
  });
});

describe("parseDflashFieldFromSseChunk", () => {
  it("returns empty array when the field is absent", () => {
    expect(parseDflashFieldFromSseChunk({ choices: [] })).toEqual([]);
    expect(parseDflashFieldFromSseChunk(null)).toEqual([]);
  });

  it("parses a single-event field", () => {
    const events = parseDflashFieldFromSseChunk({
      choices: [],
      dflash: { kind: "accept", drafted: [1], accepted: [1], ts: 0 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("accept");
  });

  it("parses an array of events", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: [
        { kind: "speculate-start", round: 1, ts: 0 },
        { kind: "accept", drafted: [1, 2], accepted: [1, 2], ts: 1 },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["speculate-start", "accept"]);
  });

  it("filters malformed entries silently", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: [
        { kind: "accept", drafted: [1], accepted: [1], ts: 0 },
        { kind: "garbage", ts: 0 },
        {
          kind: "speculate-end",
          round: 0,
          totalDrafted: 2,
          totalAccepted: 1,
          ts: 1,
        },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["accept", "speculate-end"]);
  });

  it("parses the native verifier-batch shape (all accepted, no reject)", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: {
        type: "dflash_event",
        draft_tokens: [10, 11, 12],
        accept_count: 3,
        reject_range: null,
        accept_tokens: [10, 11, 12],
        timing: { proposal_ms: 2.5, verify_ms: 7.25 },
        ts: 9999,
      },
    });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.kind).toBe("accept");
    if (ev?.kind === "accept") {
      expect(ev.drafted).toEqual([10, 11, 12]);
      expect(ev.accepted).toEqual([10, 11, 12]);
      expect(ev.nativeEvent).toBe(true);
      expect(ev.timing).toEqual({ proposalMs: 2.5, verifyMs: 7.25 });
      expect(ev.ts).toBe(9999);
    }
  });

  it("parses the native verifier-batch shape with a reject range", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: {
        type: "dflash_event",
        draft_tokens: [10, 11, 12, 13],
        accept_count: 2,
        reject_range: [12, 13],
        accept_tokens: [10, 11],
        timing: { proposal_ms: 1, verify_ms: 5 },
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("accept");
    expect(events[1]?.kind).toBe("reject");
    if (events[1]?.kind === "reject") {
      expect(events[1].rejectRange).toEqual([12, 13]);
      expect(events[1].nativeEvent).toBe(true);
      expect(events[1].timing).toEqual({ proposalMs: 1, verifyMs: 5 });
    }
  });

  it("parses an array mixing native batch + legacy decision events", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: [
        { kind: "speculate-start", round: 0, ts: 0 },
        {
          type: "dflash_event",
          draft_tokens: [1, 2],
          accept_count: 2,
          reject_range: null,
          accept_tokens: [1, 2],
          timing: { proposal_ms: 0.5, verify_ms: 2 },
        },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["speculate-start", "accept"]);
    expect((events[1] as { nativeEvent?: boolean }).nativeEvent).toBe(true);
    expect(
      (events[0] as { nativeEvent?: boolean }).nativeEvent,
    ).toBeUndefined();
  });

  it("rejects native batch when accept_count disagrees with accept_tokens", () => {
    // Parser drops the entry silently (returns [] from the batch path,
    // and we don't fall back to legacy for an already-recognised shape).
    const events = parseDflashFieldFromSseChunk({
      dflash: {
        type: "dflash_event",
        draft_tokens: [1, 2, 3],
        accept_count: 5, // > 3, invalid
        reject_range: null,
        accept_tokens: [1, 2, 3],
        timing: { proposal_ms: 1, verify_ms: 1 },
      },
    });
    expect(events).toHaveLength(0);
  });
});

describe("dflashBatchEventSchema (verifier-batch native shape)", () => {
  it("validates a minimal batch", () => {
    const parsed = dflashBatchEventSchema.safeParse({
      type: "dflash_event",
      draft_tokens: [1, 2],
      accept_count: 2,
      reject_range: null,
      accept_tokens: [1, 2],
      timing: { proposal_ms: 1, verify_ms: 2 },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative token ids", () => {
    const parsed = dflashBatchEventSchema.safeParse({
      type: "dflash_event",
      draft_tokens: [-1],
      accept_count: 0,
      reject_range: null,
      accept_tokens: [],
      timing: { proposal_ms: 0, verify_ms: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects negative timing", () => {
    const parsed = dflashBatchEventSchema.safeParse({
      type: "dflash_event",
      draft_tokens: [],
      accept_count: 0,
      reject_range: null,
      accept_tokens: [],
      timing: { proposal_ms: -1, verify_ms: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects wrong discriminator", () => {
    expect(parseDflashBatchEvent({ type: "not_dflash_event" })).toBeNull();
    expect(parseDflashBatchEvent({})).toBeNull();
    expect(parseDflashBatchEvent(null)).toBeNull();
  });

  it("expands all-accepted batch into exactly one accept event", () => {
    const events = expandDflashBatchEvent({
      type: "dflash_event",
      draft_tokens: [1, 2, 3],
      accept_count: 3,
      reject_range: null,
      accept_tokens: [1, 2, 3],
      timing: { proposal_ms: 3, verify_ms: 5 },
    });
    expect(events.map((e) => e.kind)).toEqual(["accept"]);
  });

  it("expands partial-accept batch with reject into accept + reject", () => {
    const events = expandDflashBatchEvent({
      type: "dflash_event",
      draft_tokens: [1, 2, 3, 4],
      accept_count: 2,
      reject_range: [2, 3],
      accept_tokens: [1, 2],
      timing: { proposal_ms: 1, verify_ms: 1 },
    });
    expect(events.map((e) => e.kind)).toEqual(["accept", "reject"]);
  });
});

describe("computeAcceptanceRate", () => {
  it("returns 0 when no tokens drafted", () => {
    expect(computeAcceptanceRate([])).toBe(0);
    expect(
      computeAcceptanceRate([
        { kind: "speculate-start", round: 0, ts: 0 },
      ] as DflashStreamEvent[]),
    ).toBe(0);
  });

  it("averages accepted/drafted across events", () => {
    const rate = computeAcceptanceRate([
      { kind: "accept", drafted: [1, 2, 3], accepted: [1, 2], ts: 0 },
      { kind: "accept", drafted: [4, 5], accepted: [4], ts: 1 },
    ]);
    // 3 of 5
    expect(rate).toBeCloseTo(3 / 5);
  });
});

describe("groupByRound", () => {
  it("groups events by surrounding speculate-start markers", () => {
    const events: DflashStreamEvent[] = [
      { kind: "speculate-start", round: 0, ts: 0 },
      { kind: "accept", drafted: [1, 2], accepted: [1], ts: 1 },
      {
        kind: "speculate-end",
        round: 0,
        totalDrafted: 2,
        totalAccepted: 1,
        ts: 2,
      },
      { kind: "speculate-start", round: 1, ts: 3 },
      { kind: "accept", drafted: [3], accepted: [3], ts: 4 },
    ];
    const rounds = groupByRound(events);
    expect(rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(rounds[0]?.drafted).toBe(2);
    expect(rounds[0]?.accepted).toBe(1);
    expect(rounds[1]?.drafted).toBe(1);
    expect(rounds[1]?.accepted).toBe(1);
  });

  it("buckets events before any start into round -1", () => {
    const rounds = groupByRound([
      { kind: "accept", drafted: [1], accepted: [1], ts: 0 },
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.round).toBe(-1);
  });
});

describe("summarizeEvents", () => {
  it("counts drafted/accepted and distinct rounds", () => {
    const stats = summarizeEvents([
      { kind: "speculate-start", round: 0, ts: 0 },
      { kind: "accept", drafted: [1, 2, 3], accepted: [1, 2], ts: 1 },
      {
        kind: "speculate-end",
        round: 0,
        totalDrafted: 3,
        totalAccepted: 2,
        ts: 2,
      },
      { kind: "speculate-start", round: 1, ts: 3 },
      { kind: "accept", drafted: [4], accepted: [], ts: 4 },
      {
        kind: "speculate-end",
        round: 1,
        totalDrafted: 1,
        totalAccepted: 0,
        ts: 5,
      },
    ]);
    expect(stats).toEqual({
      drafted: 4,
      accepted: 2,
      rounds: 2,
      acceptanceRate: 0.5,
    });
  });

  it("returns zero-rate when nothing drafted", () => {
    expect(summarizeEvents([])).toEqual({
      drafted: 0,
      accepted: 0,
      rounds: 0,
      acceptanceRate: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// dflash-verify event round-trip tests (L1)
// ---------------------------------------------------------------------------

describe("parseDflashStreamEvent — dflash-verify", () => {
  const validVerify: DflashVerifyStreamEvent = {
    kind: "dflash-verify",
    drafted_count: 4,
    accept_count: 3,
    reject_index: 3,
    correction_token_id: 99,
    verify_latency_ms: 12.5,
  };

  it("parses a well-formed dflash-verify event (partial accept)", () => {
    const ev = parseDflashStreamEvent(validVerify);
    expect(ev).toEqual(validVerify);
  });

  it("parses dflash-verify with all tokens accepted (reject_index = -1, correction_token_id = null)", () => {
    const allAccepted: DflashVerifyStreamEvent = {
      kind: "dflash-verify",
      drafted_count: 5,
      accept_count: 5,
      reject_index: -1,
      correction_token_id: null,
      verify_latency_ms: 8.0,
    };
    const ev = parseDflashStreamEvent(allAccepted);
    expect(ev).toEqual(allAccepted);
  });

  it("rejects dflash-verify when accept_count > drafted_count", () => {
    expect(
      parseDflashStreamEvent({
        kind: "dflash-verify",
        drafted_count: 2,
        accept_count: 5,
        reject_index: -1,
        correction_token_id: null,
        verify_latency_ms: 1,
      }),
    ).toBeNull();
  });

  it("rejects dflash-verify when reject_index < -1", () => {
    expect(
      parseDflashStreamEvent({
        kind: "dflash-verify",
        drafted_count: 4,
        accept_count: 2,
        reject_index: -2,
        correction_token_id: null,
        verify_latency_ms: 1,
      }),
    ).toBeNull();
  });

  it("rejects dflash-verify when correction_token_id is a negative number", () => {
    expect(
      parseDflashStreamEvent({
        kind: "dflash-verify",
        drafted_count: 4,
        accept_count: 2,
        reject_index: 2,
        correction_token_id: -1,
        verify_latency_ms: 1,
      }),
    ).toBeNull();
  });

  it("rejects dflash-verify when verify_latency_ms is negative", () => {
    expect(
      parseDflashStreamEvent({
        kind: "dflash-verify",
        drafted_count: 4,
        accept_count: 2,
        reject_index: 2,
        correction_token_id: null,
        verify_latency_ms: -1,
      }),
    ).toBeNull();
  });

  it("rejects dflash-verify when drafted_count is missing", () => {
    expect(
      parseDflashStreamEvent({
        kind: "dflash-verify",
        accept_count: 2,
        reject_index: 2,
        correction_token_id: null,
        verify_latency_ms: 1,
      }),
    ).toBeNull();
  });

  it("round-trips through parseDflashFieldFromSseChunk — single event", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: validVerify,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(validVerify);
  });

  it("round-trips through parseDflashFieldFromSseChunk — array", () => {
    const allAccepted: DflashVerifyStreamEvent = {
      kind: "dflash-verify",
      drafted_count: 3,
      accept_count: 3,
      reject_index: -1,
      correction_token_id: null,
      verify_latency_ms: 5.0,
    };
    const events = parseDflashFieldFromSseChunk({
      dflash: [{ kind: "speculate-start", round: 0, ts: 0 }, allAccepted],
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("speculate-start");
    expect(events[1]).toEqual(allAccepted);
  });

  it("filters malformed dflash-verify entries in an array without dropping valid ones", () => {
    const events = parseDflashFieldFromSseChunk({
      dflash: [
        {
          kind: "dflash-verify",
          drafted_count: 10,
          accept_count: 999, // invalid: > drafted_count
          reject_index: -1,
          correction_token_id: null,
          verify_latency_ms: 1,
        },
        validVerify,
      ],
    });
    // Malformed entry is dropped, valid entry is preserved.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(validVerify);
  });
});
