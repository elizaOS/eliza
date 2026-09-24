/**
 * Honest-scoring regression tests (#9310 §3.11).
 *
 * Guards the two audit findings:
 *   1. Empty/missing axes must never score a free 1.0 — an axis without
 *      checks scores 0, an unmeasurable axis is excluded from normalization.
 *   2. Scheduled tasks are created only by an explicit `schedule_followup`
 *      threadOp — never inferred from instruction text by a hardcoded oracle
 *      regex (the old `(meeting|carol|bob).*(friday|...)` shortcut).
 */

import { describe, expect, it } from "vitest";
import { runScenario } from "../src/evaluator.ts";
import { loadScenarios } from "../src/scenarios.ts";
import { scoreScenario } from "../src/scorer.ts";
import { SimulatorState } from "../src/state.ts";
import { Trace } from "../src/trace.ts";
import type { Scenario } from "../src/types.ts";

function emptyExpectationsScenario(): Scenario {
  return {
    id: "T0-empty-expectations",
    category: "T",
    interruptionType: "addition",
    weight: 1,
    setup: {
      agentId: "agent-test",
      rooms: [{ id: "dm-alice", kind: "dm", owner: "alice" }],
      users: [{ id: "alice", role: "OWNER" }],
      openThreads: [],
      scheduledTasks: [],
      memory: [],
    },
    script: [{ t: 0, channel: "dm-alice", sender: "alice", text: "hi" }],
    expectedFinalState: {
      threads: [],
      scheduledTasks: [],
      repliesByChannel: {},
    },
    expectedTrace: {
      stage1Calls: { min: 1, max: 2 },
      boundaryViolations: 0,
    },
    responseRubric: { judgePrompt: "n/a", passRequiredForBonus: false },
  };
}

describe("empty axes are never a free 1.0", () => {
  it("scores an all-empty scenario near zero instead of ~0.9", () => {
    const scenario = emptyExpectationsScenario();
    const result = scoreScenario({
      scenario,
      finalState: SimulatorState.fromSetup(scenario.setup),
      trace: new Trace(() => 0),
      durationMs: 0,
      mode: "scripted",
    });

    // state: no expectations → 0, not 1.
    expect(result.axes.state.raw).toBe(0);
    expect(result.axes.state.notes[0]).toContain("no state expectations");
    // routing: no expectations and no replies → excluded, not 1.
    expect(result.axes.routing.excluded).toBe(true);
    expect(result.axes.routing.weighted).toBe(0);
    // intent: not defined → excluded from normalization, not 1.
    expect(result.axes.intent.excluded).toBe(true);
    expect(result.axes.intent.weighted).toBe(0);
    // latency: nothing ran → 0, not 1.
    expect(result.axes.latency.raw).toBe(0);
    // Only the boundary axis legitimately passes (0 violations ≤ 0 allowed):
    // 0.15 / (0.3 + 0.1 + 0.15 + 0.05) = 0.25 — far below the old free-pass
    // ~0.9 that empty axes used to produce.
    expect(result.score).toBeCloseTo(0.25, 5);
  });

  it("renormalizes over included axes so a fully-passing run still scores 1", async () => {
    const scenario = loadScenarios().find(
      (s) => s.id === "A1-fragmented-email-draft",
    );
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("A1 not found");
    const result = await runScenario(scenario, { mode: "scripted" });
    expect(result.score).toBe(1);
  });
});

describe("scheduling has no text oracle", () => {
  it("a create op with oracle-matching text does NOT schedule a task", async () => {
    const scenario = loadScenarios().find(
      (s) => s.id === "A4-stream-with-retraction",
    );
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("A4 not found");

    // Provider mimics an agent that creates a thread whose instruction would
    // have satisfied the removed regex oracle, but never emits the explicit
    // schedule_followup op. Under honest semantics no task is scheduled and
    // the state axis must fail.
    const result = await runScenario(scenario, {
      mode: "scripted",
      scripted: () => ({
        parsed: {
          shouldRespond: "RESPOND",
          contexts: [],
          intents: [],
          candidateActionNames: [],
          replyText: "On it.",
          facts: [],
          relationships: [],
          addressedTo: [],
          threadOps: [
            {
              type: "create",
              workThreadId: null,
              sourceWorkThreadIds: [],
              sourceRef: null,
              instruction: "meeting with carol friday at 10am",
              reason: "test",
            },
          ],
        },
        latencyMs: 50,
      }),
    });

    expect(result.axes.state.raw).toBeLessThan(1);
    expect(
      result.axes.state.notes.some((n) => n.includes("scheduledTask mismatch")),
    ).toBe(true);
  });

  it("the explicit schedule_followup op schedules the task (ideal agent passes A4)", async () => {
    const scenario = loadScenarios().find(
      (s) => s.id === "A4-stream-with-retraction",
    );
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("A4 not found");
    const result = await runScenario(scenario, { mode: "scripted" });
    expect(result.axes.state.raw).toBe(1);
    expect(result.score).toBe(1);
  });
});
