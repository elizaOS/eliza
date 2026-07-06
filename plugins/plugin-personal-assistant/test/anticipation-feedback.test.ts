/**
 * Covers the anticipation-feedback loop: proactive-dispatch markers (record /
 * age-out / bounds), the anticipation_feedback evaluator's shouldRun gate,
 * parse, and processor (newest marker model-classified, older ones counted
 * ignored, markers removed so the turn is never classified twice), and the
 * durable rolling stats. Deterministic — real stores against the real runtime
 * cache contract, no model call.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  anticipationFeedbackEvaluator,
  parseAnticipationFeedbackOutput,
} from "../src/lifeops/anticipation/evaluator.ts";
import {
  listUnprocessedDispatches,
  readAnticipationStats,
  recordAnticipationFeedback,
  recordProactiveDispatch,
} from "../src/lifeops/anticipation/store.ts";
import { createOwnerRuntimeStub } from "./first-run-helpers.ts";

const ROOM_ID = "room-anticipation-1";
const EMPTY_STATE = { values: {}, data: {}, text: "" } as never;

function ownerReply(runtime: IAgentRuntime, text: string): Memory {
  return {
    id: "msg-reply-1",
    entityId: "owner-entity-1",
    roomId: ROOM_ID,
    agentId: runtime.agentId,
    content: { text },
    createdAt: Date.now(),
  } as never;
}

async function recordMarker(
  runtime: IAgentRuntime,
  taskId: string,
  firedAt: string,
  snippet = "Morning! Want a quick plan for today?",
): Promise<void> {
  await recordProactiveDispatch(runtime, {
    roomId: ROOM_ID,
    taskId,
    firedAt,
    snippet,
  });
}

describe("proactive-dispatch marker store", () => {
  it("validates inputs", async () => {
    const runtime = createOwnerRuntimeStub();
    await expect(
      recordProactiveDispatch(runtime, {
        roomId: "",
        taskId: "t1",
        firedAt: new Date().toISOString(),
        snippet: "x",
      }),
    ).rejects.toThrow(/roomId/);
    await expect(
      recordProactiveDispatch(runtime, {
        roomId: ROOM_ID,
        taskId: "t1",
        firedAt: "not-a-date",
        snippet: "x",
      }),
    ).rejects.toThrow(/ISO-8601/);
  });

  it("lists markers oldest-first and re-recording a task replaces its marker", async () => {
    const runtime = createOwnerRuntimeStub();
    const base = Date.now();
    await recordMarker(runtime, "t2", new Date(base - 60_000).toISOString());
    await recordMarker(runtime, "t1", new Date(base - 120_000).toISOString());
    let markers = await listUnprocessedDispatches(runtime, ROOM_ID);
    expect(markers.map((m) => m.taskId)).toEqual(["t1", "t2"]);

    const refire = new Date(base - 1_000).toISOString();
    await recordMarker(runtime, "t1", refire, "updated nudge");
    markers = await listUnprocessedDispatches(runtime, ROOM_ID);
    expect(markers.map((m) => m.taskId)).toEqual(["t2", "t1"]);
    expect(markers[1]?.snippet).toBe("updated nudge");
  });

  it("ages markers out after the retention window", async () => {
    const runtime = createOwnerRuntimeStub();
    const now = new Date();
    await recordMarker(
      runtime,
      "stale",
      new Date(now.getTime() - 25 * 3_600_000).toISOString(),
    );
    await recordMarker(
      runtime,
      "fresh",
      new Date(now.getTime() - 3_600_000).toISOString(),
    );
    const markers = await listUnprocessedDispatches(runtime, ROOM_ID, { now });
    expect(markers.map((m) => m.taskId)).toEqual(["fresh"]);
  });

  it("bounds the per-room marker ring to the newest entries", async () => {
    const runtime = createOwnerRuntimeStub();
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      await recordMarker(
        runtime,
        `t${i}`,
        new Date(base - (10 - i) * 60_000).toISOString(),
      );
    }
    const markers = await listUnprocessedDispatches(runtime, ROOM_ID);
    expect(markers).toHaveLength(8);
    expect(markers[0]?.taskId).toBe("t2");
    expect(markers[7]?.taskId).toBe("t9");
  });
});

describe("anticipation_feedback output parsing", () => {
  it("accepts only the three outcomes", () => {
    expect(parseAnticipationFeedbackOutput({ outcome: "accepted" })).toEqual({
      outcome: "accepted",
    });
    expect(parseAnticipationFeedbackOutput({ outcome: "rejected" })).toEqual({
      outcome: "rejected",
    });
    expect(parseAnticipationFeedbackOutput({ outcome: "ignored" })).toEqual({
      outcome: "ignored",
    });
    expect(parseAnticipationFeedbackOutput({ outcome: "maybe" })).toBeNull();
    expect(parseAnticipationFeedbackOutput("accepted")).toBeNull();
    expect(parseAnticipationFeedbackOutput(null)).toBeNull();
  });
});

describe("anticipation_feedback evaluator", () => {
  it("shouldRun is false without unprocessed markers and for the agent's own turns", async () => {
    const runtime = createOwnerRuntimeStub();
    expect(
      await anticipationFeedbackEvaluator.shouldRun({
        runtime,
        message: ownerReply(runtime, "hello"),
        options: {},
      }),
    ).toBe(false);

    await recordMarker(runtime, "t1", new Date().toISOString());
    const agentTurn = {
      ...ownerReply(runtime, "here is your plan"),
      entityId: runtime.agentId,
    } as Memory;
    expect(
      await anticipationFeedbackEvaluator.shouldRun({
        runtime,
        message: agentTurn,
        options: {},
      }),
    ).toBe(false);
    expect(
      await anticipationFeedbackEvaluator.shouldRun({
        runtime,
        message: ownerReply(runtime, "yes please!"),
        options: {},
      }),
    ).toBe(true);
  });

  it("prompt embeds the newest proactive snippet", async () => {
    const runtime = createOwnerRuntimeStub();
    await recordMarker(
      runtime,
      "t1",
      new Date().toISOString(),
      "Want me to prep your morning brief?",
    );
    const message = ownerReply(runtime, "sure");
    const prepared = await anticipationFeedbackEvaluator.prepare?.({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
    });
    const prompt = anticipationFeedbackEvaluator.prompt({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
      prepared: prepared as never,
    });
    expect(prompt).toContain("Want me to prep your morning brief?");
  });

  it("processor records the classified outcome, marks older markers ignored, and never double-processes", async () => {
    const runtime = createOwnerRuntimeStub();
    const base = Date.now();
    await recordMarker(runtime, "old", new Date(base - 120_000).toISOString());
    await recordMarker(runtime, "new", new Date(base - 30_000).toISOString());

    const message = ownerReply(runtime, "yes, that helps — thanks!");
    const prepared = await anticipationFeedbackEvaluator.prepare?.({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
    });
    const processor = anticipationFeedbackEvaluator.processors?.[0];
    if (!processor) {
      throw new Error("anticipation_feedback must register its processor");
    }
    const result = await processor.process({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
      prepared: prepared as never,
      output: { outcome: "accepted" },
      evaluatorName: anticipationFeedbackEvaluator.name,
    });
    expect(result).toMatchObject({
      success: true,
      values: {
        anticipationOutcome: "accepted",
        anticipationAccepted: 1,
        anticipationIgnored: 1,
        anticipationRejected: 0,
      },
    });

    // Markers are consumed: the same owner turn cannot be classified twice.
    expect(await listUnprocessedDispatches(runtime, ROOM_ID)).toHaveLength(0);
    expect(
      await anticipationFeedbackEvaluator.shouldRun({
        runtime,
        message,
        options: {},
      }),
    ).toBe(false);

    const stats = await readAnticipationStats(runtime);
    expect(stats).toMatchObject({ accepted: 1, rejected: 0, ignored: 1 });
    expect(stats.recent.map((entry) => entry.outcome)).toEqual([
      "ignored",
      "accepted",
    ]);
  });
});

describe("rolling anticipation stats", () => {
  it("accumulates durably and bounds the recent ring", async () => {
    const runtime = createOwnerRuntimeStub();
    const now = new Date();
    for (let i = 0; i < 25; i += 1) {
      await recordAnticipationFeedback(
        runtime,
        ROOM_ID,
        [
          {
            marker: {
              taskId: `t${i}`,
              firedAt: now.toISOString(),
              snippet: "nudge",
            },
            outcome: i % 2 === 0 ? "accepted" : "rejected",
          },
        ],
        { now },
      );
    }
    const stats = await readAnticipationStats(runtime, { now });
    expect(stats.accepted).toBe(13);
    expect(stats.rejected).toBe(12);
    expect(stats.recent).toHaveLength(20);
    expect(stats.recent[stats.recent.length - 1]?.taskId).toBe("t24");
  });
});
