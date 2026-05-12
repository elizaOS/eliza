import { describe, expect, it } from "vitest";
import {
  computeAcceptanceRate,
  type DflashStreamEvent,
  groupByRound,
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
