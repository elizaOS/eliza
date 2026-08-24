/**
 * Verifies autonomy run-health tracking over real streamed envelopes: sequence
 * gap detection, recovery, store hydration on reconnect, dedup, ledger
 * trimming, watermark cursor movement, and gap-replay request building.
 */
import { describe, expect, it } from "vitest";
import type { StreamEventEnvelope } from "../api/client";
import type { AutonomyRunHealth, AutonomyRunHealthMap } from "./autonomy";
import {
  buildAutonomyGapReplayRequests,
  hasPendingAutonomyGaps,
  markPendingAutonomyGapsPartial,
  mergeAutonomyEvents,
} from "./autonomy";

function evt(
  eventId: string,
  opts: { runId?: string; seq?: number; stream?: string; ts?: number } = {},
): StreamEventEnvelope {
  return {
    type: "agent_event",
    version: 1,
    eventId,
    ts: opts.ts ?? 1_000,
    runId: opts.runId,
    seq: opts.seq,
    stream: opts.stream,
    payload: null,
  };
}

function healthOf(
  runId: string,
  missingSeqs: number[],
  lastSeq: number | null,
): AutonomyRunHealth {
  return { runId, status: "ok", lastSeq, missingSeqs, gapCount: 0 };
}

describe("mergeAutonomyEvents", () => {
  it("returns an empty ledger for a cold start with nothing to merge", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [],
      runHealthByRunId: {},
    });

    expect(result.events).toEqual([]);
    expect(result.latestEventId).toBeNull();
    expect(result.insertedCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
    expect(result.runsWithNewGaps).toEqual([]);
    expect(result.runsRecovered).toEqual([]);
    expect(result.hasUnresolvedGaps).toBe(false);
    expect(result.store.eventOrder).toEqual([]);
    expect(result.store.watermark).toBeNull();
  });

  it("tracks lastSeq across an initial batch without inventing cold-start gaps", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens", ts: 100 }),
        evt("evt-2", { runId: "run-1", seq: 2, stream: "tokens", ts: 200 }),
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens", ts: 300 }),
      ],
      runHealthByRunId: {},
    });

    expect(result.insertedCount).toBe(3);
    expect(result.events.map((e) => e.eventId)).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
    expect(result.latestEventId).toBe("evt-3");
    expect(result.store.runIndex["run-1"]).toEqual({
      1: "evt-1",
      2: "evt-2",
      3: "evt-3",
    });
    expect(result.runHealthByRunId["run-1"]).toMatchObject({
      status: "ok",
      lastSeq: 3,
      missingSeqs: [],
    });
    expect(result.hasUnresolvedGaps).toBe(false);
  });

  it("flags a skipped seq as gap_detected with gap metadata", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens", ts: 100 }),
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens", ts: 300 }),
      ],
      runHealthByRunId: {},
    });

    const health = result.runHealthByRunId["run-1"];
    expect(health.status).toBe("gap_detected");
    expect(health.missingSeqs).toEqual([2]);
    expect(health.gapCount).toBe(1);
    expect(health.lastGapAt).toBe(300);
    expect(health.lastSeq).toBe(3);
    expect(result.runsWithNewGaps).toEqual(["run-1"]);
    expect(result.hasUnresolvedGaps).toBe(true);
  });

  it("recovers when the missing envelope arrives later in the same batch", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens", ts: 100 }),
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens", ts: 300 }),
        evt("evt-2", { runId: "run-1", seq: 2, stream: "tokens", ts: 200 }),
      ],
      runHealthByRunId: {},
    });

    const health = result.runHealthByRunId["run-1"];
    expect(health.status).toBe("recovered");
    expect(health.recoveredAt).toBe(200);
    expect(health.missingSeqs).toEqual([]);
    expect(health.lastSeq).toBe(3);
    expect(result.runsRecovered).toEqual(["run-1"]);
    expect(result.runsWithNewGaps).toEqual(["run-1"]);
    expect(result.hasUnresolvedGaps).toBe(false);
  });

  it("keeps the run flagged while any missing seq is outstanding across calls", () => {
    const first = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("evt-4", { runId: "run-1", seq: 4, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });
    expect(first.runHealthByRunId["run-1"].missingSeqs).toEqual([2, 3]);

    const second = mergeAutonomyEvents({
      store: first.store,
      incomingEvents: [
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens" }),
      ],
      runHealthByRunId: first.runHealthByRunId,
    });
    expect(second.runHealthByRunId["run-1"].status).toBe("gap_detected");
    expect(second.runHealthByRunId["run-1"].missingSeqs).toEqual([2]);
    expect(second.runsRecovered).toEqual([]);

    const third = mergeAutonomyEvents({
      store: second.store,
      incomingEvents: [
        evt("evt-2", { runId: "run-1", seq: 2, stream: "tokens" }),
      ],
      runHealthByRunId: second.runHealthByRunId,
    });
    expect(third.runHealthByRunId["run-1"].status).toBe("recovered");
    expect(third.runsRecovered).toEqual(["run-1"]);
    expect(third.hasUnresolvedGaps).toBe(false);
  });

  it("reconstructs gaps from a carried store on reconnect with a fresh health map", () => {
    const connected = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });

    const reconnected = mergeAutonomyEvents({
      store: connected.store,
      incomingEvents: [],
      runHealthByRunId: {},
    });

    const health = reconnected.runHealthByRunId["run-1"];
    expect(health.status).toBe("gap_detected");
    expect(health.missingSeqs).toEqual([2]);
    expect(health.lastSeq).toBe(3);
    expect(health.gapCount).toBe(1);
    expect(reconnected.hasUnresolvedGaps).toBe(true);
    expect(reconnected.events.map((e) => e.eventId)).toEqual([
      "evt-1",
      "evt-3",
    ]);
    expect(reconnected.latestEventId).toBe("evt-3");
  });

  it("does not mutate the caller's store or health map", () => {
    const initial = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("evt-2", { runId: "run-1", seq: 2, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });
    const healthBefore = structuredClone(initial.runHealthByRunId);
    const orderBefore = [...initial.store.eventOrder];

    mergeAutonomyEvents({
      store: initial.store,
      incomingEvents: [
        evt("evt-9", { runId: "run-1", seq: 9, stream: "tokens" }),
      ],
      runHealthByRunId: initial.runHealthByRunId,
    });

    expect(initial.store.eventOrder).toEqual(orderBefore);
    expect(initial.store.eventsById["evt-9"]).toBeUndefined();
    expect(initial.runHealthByRunId).toEqual(healthBefore);
  });

  it("counts duplicates by eventId and by run/seq/stream fallback key", () => {
    const first = evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" });
    const sameEnvelopeDifferentId = evt("evt-1b", {
      runId: "run-1",
      seq: 1,
      stream: "tokens",
    });

    const result = mergeAutonomyEvents({
      incomingEvents: [
        first,
        sameEnvelopeDifferentId,
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });

    expect(result.insertedCount).toBe(1);
    expect(result.duplicateCount).toBe(2);
    expect(result.events.map((e) => e.eventId)).toEqual(["evt-1"]);
  });

  it("skips health tracking for envelopes lacking runId or seq", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-x"),
        evt("evt-y", { runId: "run-noseq" }),
        evt("evt-z", { runId: "run-1", seq: 1, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });

    expect(result.insertedCount).toBe(3);
    expect(Object.keys(result.runHealthByRunId)).toEqual(["run-1"]);
    expect(Object.keys(result.store.eventsById).sort()).toEqual([
      "evt-x",
      "evt-y",
      "evt-z",
    ]);
    expect(Object.keys(result.store.runIndex)).toEqual(["run-1"]);
  });

  it("never indexes prototype-dangerous runIds into the run index", () => {
    const result = mergeAutonomyEvents({
      existingEvents: [
        evt("evt-p1", { runId: "constructor", seq: 1, stream: "tokens" }),
        evt("evt-p2", { runId: "prototype", seq: 2, stream: "tokens" }),
      ],
      incomingEvents: [
        evt("evt-p3", { runId: "prototype", seq: 3, stream: "tokens" }),
        evt("evt-ok", { runId: "run-1", seq: 4, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });

    expect(Object.hasOwn(result.store.runIndex, "constructor")).toBe(false);
    expect(Object.hasOwn(result.store.runIndex, "prototype")).toBe(false);
    expect(Object.keys(result.store.runIndex)).toEqual(["run-1"]);
    expect(result.store.eventsById["evt-p1"]).toBeDefined();
    expect(result.store.eventsById["evt-p2"]).toBeDefined();
    expect(result.store.eventsById["evt-p3"]).toBeDefined();
  });

  it("marks unresolved runs partial on replay even with no incoming events", () => {
    const connected = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("evt-3", { runId: "run-1", seq: 3, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });
    const before = Date.now();

    const replayed = mergeAutonomyEvents({
      store: connected.store,
      incomingEvents: [],
      runHealthByRunId: connected.runHealthByRunId,
      replay: true,
    });

    const health = replayed.runHealthByRunId["run-1"];
    expect(health.status).toBe("partial");
    expect(health.partialAt).toBeGreaterThanOrEqual(before);
    expect(replayed.insertedCount).toBe(0);
    expect(replayed.hasUnresolvedGaps).toBe(true);
  });

  it("trims the ledger to maxEvents and drops evicted seqs from the run index", () => {
    const trimmed = mergeAutonomyEvents({
      incomingEvents: [1, 2, 3, 4, 5].map((seq) =>
        evt(`evt-${seq}`, { runId: "run-1", seq, stream: "tokens" }),
      ),
      runHealthByRunId: {},
      maxEvents: 3,
    });

    expect(trimmed.events.map((e) => e.eventId)).toEqual([
      "evt-3",
      "evt-4",
      "evt-5",
    ]);
    expect(trimmed.store.eventsById["evt-1"]).toBeUndefined();
    expect(trimmed.store.eventsById["evt-2"]).toBeUndefined();
    expect(trimmed.store.runIndex["run-1"]).toEqual({
      3: "evt-3",
      4: "evt-4",
      5: "evt-5",
    });
    expect(trimmed.latestEventId).toBe("evt-5");

    const rehydrated = mergeAutonomyEvents({
      store: trimmed.store,
      incomingEvents: [],
      runHealthByRunId: {},
    });
    expect(rehydrated.runHealthByRunId["run-1"]).toMatchObject({
      status: "ok",
      lastSeq: 5,
      missingSeqs: [],
    });
  });

  it("does not move the watermark cursor backwards on late low-seq arrivals", () => {
    const first = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-10", { runId: "run-1", seq: 10, stream: "tokens" }),
        evt("evt-11", { runId: "run-1", seq: 11, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });
    expect(first.latestEventId).toBe("evt-11");

    const late = mergeAutonomyEvents({
      store: first.store,
      incomingEvents: [
        evt("evt-9", { runId: "run-1", seq: 9, stream: "tokens" }),
      ],
      runHealthByRunId: first.runHealthByRunId,
    });

    expect(late.insertedCount).toBe(1);
    expect(late.latestEventId).toBe("evt-11");
  });

  it("advances the cursor to a non-ordinal eventId when one arrives", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("snapshot-final"),
      ],
      runHealthByRunId: {},
    });

    expect(result.latestEventId).toBe("snapshot-final");
  });

  it("truncates fractional seqs onto the integer run index", () => {
    const result = mergeAutonomyEvents({
      incomingEvents: [
        evt("evt-1", { runId: "run-1", seq: 1, stream: "tokens" }),
        evt("evt-2", { runId: "run-1", seq: 2.9, stream: "tokens" }),
      ],
      runHealthByRunId: {},
    });

    expect(result.store.runIndex["run-1"][2]).toBe("evt-2");
    expect(result.runHealthByRunId["run-1"].lastSeq).toBe(2);
    expect(result.runHealthByRunId["run-1"].missingSeqs).toEqual([]);
    expect(result.runsWithNewGaps).toEqual([]);
  });
});

describe("buildAutonomyGapReplayRequests", () => {
  it("returns no requests when there is no tracked health", () => {
    expect(
      buildAutonomyGapReplayRequests(
        {},
        {
          eventsById: {},
          eventOrder: [],
          runIndex: {},
          watermark: null,
        },
      ),
    ).toEqual([]);
  });

  it("requests only unresolved seqs and sorts by fromSeq", () => {
    const runHealthByRunId = {
      "run-a": {
        ...healthOf("run-a", [2, 3, 5], 5),
        status: "gap_detected" as const,
      },
      "run-b": {
        ...healthOf("run-b", [1], 1),
        status: "gap_detected" as const,
      },
      "run-c": {
        ...healthOf("run-c", [4], 4),
        status: "gap_detected" as const,
      },
    };
    const store = {
      eventsById: {},
      eventOrder: [],
      runIndex: {
        "run-a": { 2: "evt-a2" },
        "run-c": { 4: "evt-c4" },
      },
      watermark: null,
    };

    const requests = buildAutonomyGapReplayRequests(runHealthByRunId, store);

    expect(requests).toEqual([
      { runId: "run-b", fromSeq: 1, missingSeqs: [1] },
      { runId: "run-a", fromSeq: 3, missingSeqs: [3, 5] },
    ]);
  });
});

describe("hasPendingAutonomyGaps", () => {
  it("is false for an empty map and for fully healthy runs", () => {
    expect(hasPendingAutonomyGaps({})).toBe(false);
    expect(hasPendingAutonomyGaps({ "run-1": healthOf("run-1", [], 7) })).toBe(
      false,
    );
  });

  it("is true when any run still has missing seqs", () => {
    expect(
      hasPendingAutonomyGaps({
        "run-1": healthOf("run-1", [], 7),
        "run-2": healthOf("run-2", [4], 5),
      }),
    ).toBe(true);
  });
});

describe("markPendingAutonomyGapsPartial", () => {
  it("marks only gapped runs partial and never mutates its input", () => {
    const input: AutonomyRunHealthMap = {
      healthy: healthOf("healthy", [], 4),
      gapped: {
        runId: "gapped",
        status: "gap_detected" as const,
        lastSeq: 5,
        missingSeqs: [2, 4],
        gapCount: 1,
      },
    };

    const marked = markPendingAutonomyGapsPartial(input, 12345);

    expect(marked.gapped.status).toBe("partial");
    expect(marked.gapped.partialAt).toBe(12345);
    expect(marked.gapped.missingSeqs).toEqual([2, 4]);
    expect(marked.healthy.status).toBe("ok");
    expect(marked.healthy.partialAt).toBeUndefined();

    expect(marked.gapped).not.toBe(input.gapped);
    expect(marked.gapped.missingSeqs).not.toBe(input.gapped.missingSeqs);
    marked.gapped.missingSeqs.push(99);
    expect(input.gapped.missingSeqs).toEqual([2, 4]);
    expect(input.gapped.status).toBe("gap_detected");
    expect(input.gapped.partialAt).toBeUndefined();
  });

  it("defaults the partial timestamp to now", () => {
    const before = Date.now();
    const marked = markPendingAutonomyGapsPartial({
      "run-1": healthOf("run-1", [3], 4),
    });
    const after = Date.now();

    expect(marked["run-1"].partialAt).toBeGreaterThanOrEqual(before);
    expect(marked["run-1"].partialAt).toBeLessThanOrEqual(after);
  });
});
