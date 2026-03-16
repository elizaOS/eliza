import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import {
  buildAutonomyGapReplayRequests,
  hasPendingAutonomyGaps,
  mergeAutonomyEvents,
} from "@elizaos/app-core/autonomy";
import { describe, expect, it } from "vitest";

function makeEvent(
  eventId: string,
  runId: string,
  seq: number,
  stream = "action",
): StreamEventEnvelope {
  return {
    type: "agent_event",
    version: 1,
    eventId,
    ts: Date.now(),
    runId,
    seq,
    stream,
    payload: { text: `${runId}:${seq}` },
  };
}

describe("autonomy-events merge", () => {
  it("deduplicates events by eventId", () => {
    const existing = [makeEvent("evt-1", "run-1", 1)];
    const result = mergeAutonomyEvents({
      existingEvents: existing,
      incomingEvents: [makeEvent("evt-1", "run-1", 1)],
      runHealthByRunId: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.insertedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.store.eventOrder).toEqual(["evt-1"]);
    expect(result.store.watermark).toBe("evt-1");
  });

  it("deduplicates events by fallback runId/seq/stream key", () => {
    const existing = [makeEvent("evt-a", "run-1", 2, "tool")];
    const result = mergeAutonomyEvents({
      existingEvents: existing,
      incomingEvents: [makeEvent("evt-b", "run-1", 2, "tool")],
      runHealthByRunId: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.insertedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
  });

  it("detects sequence gaps and marks run as recovered when replay fills them", () => {
    const gap = mergeAutonomyEvents({
      existingEvents: [makeEvent("evt-1", "run-1", 1)],
      incomingEvents: [makeEvent("evt-3", "run-1", 3)],
      runHealthByRunId: {},
    });

    expect(gap.runsWithNewGaps).toEqual(["run-1"]);
    expect(hasPendingAutonomyGaps(gap.runHealthByRunId)).toBe(true);
    expect(gap.runHealthByRunId["run-1"]?.status).toBe("gap_detected");
    expect(gap.runHealthByRunId["run-1"]?.missingSeqs).toEqual([2]);

    const recovered = mergeAutonomyEvents({
      existingEvents: gap.events,
      incomingEvents: [makeEvent("evt-2", "run-1", 2)],
      runHealthByRunId: gap.runHealthByRunId,
      replay: true,
    });

    expect(recovered.runHealthByRunId["run-1"]?.status).toBe("recovered");
    expect(recovered.runHealthByRunId["run-1"]?.missingSeqs).toEqual([]);
    expect(recovered.runsRecovered).toContain("run-1");
    expect(recovered.hasUnresolvedGaps).toBe(false);
  });

  it("marks unresolved gaps as partial after replay finalization", () => {
    const gap = mergeAutonomyEvents({
      existingEvents: [makeEvent("evt-1", "run-1", 1)],
      incomingEvents: [makeEvent("evt-3", "run-1", 3)],
      runHealthByRunId: {},
    });

    const partial = mergeAutonomyEvents({
      existingEvents: gap.events,
      incomingEvents: [],
      runHealthByRunId: gap.runHealthByRunId,
      replay: true,
    });

    expect(partial.runHealthByRunId["run-1"]?.status).toBe("partial");
    expect(partial.runHealthByRunId["run-1"]?.missingSeqs).toEqual([2]);
    expect(partial.hasUnresolvedGaps).toBe(true);
  });

  it("builds per-run replay requests from unresolved gaps", () => {
    const gap = mergeAutonomyEvents({
      existingEvents: [makeEvent("evt-1", "run-1", 1)],
      incomingEvents: [makeEvent("evt-3", "run-1", 3)],
      runHealthByRunId: {},
    });

    const requests = buildAutonomyGapReplayRequests(
      gap.runHealthByRunId,
      gap.store,
    );
    expect(requests).toEqual([
      {
        runId: "run-1",
        fromSeq: 2,
        missingSeqs: [2],
      },
    ]);

    const recovered = mergeAutonomyEvents({
      store: gap.store,
      incomingEvents: [makeEvent("evt-2", "run-1", 2)],
      runHealthByRunId: gap.runHealthByRunId,
    });
    expect(
      buildAutonomyGapReplayRequests(
        recovered.runHealthByRunId,
        recovered.store,
      ),
    ).toEqual([]);
  });

  it("keeps only the newest events when maxEvents is exceeded", () => {
    const first = mergeAutonomyEvents({
      existingEvents: [],
      incomingEvents: [
        makeEvent("evt-1", "run-1", 1),
        makeEvent("evt-2", "run-1", 2),
        makeEvent("evt-3", "run-1", 3),
      ],
      runHealthByRunId: {},
      maxEvents: 2,
    });

    expect(first.events.map((event) => event.eventId)).toEqual([
      "evt-2",
      "evt-3",
    ]);
    expect(first.latestEventId).toBe("evt-3");
  });
});
