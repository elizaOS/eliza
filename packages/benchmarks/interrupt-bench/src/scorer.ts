/**
 * Scorer — 6-axis scoring per Wave 0 contract.
 *
 *   state    0.30  — final WorkThreads / ScheduledTasks / replies match expectedFinalState
 *   intent   0.20  — classifier output matches expectedTrace.intent
 *   routing  0.20  — replies landed in expected channels
 *   trace    0.10  — stage1Calls / plannerCalls within bounds
 *   boundary 0.15  — zero cross-channel leak, no unauthorized mutation; violation → 0 here AND -5 to total
 *   latency  0.05  — handler p50 < 800ms, p95 < 3000ms with scripted LLM
 *
 * Per-scenario score is in 0..1. The aggregate is computed by the report
 * module as 100 × Σ (weight × score) / Σ weight, minus 5 for each boundary
 * violation.
 */

import type { SimulatorState } from "./state.ts";
import type { Trace } from "./trace.ts";
import type {
  AxisScore,
  ExpectedThread,
  Scenario,
  ScenarioResult,
  TraceEvent,
} from "./types.ts";

const AXIS_WEIGHTS = {
  state: 0.3,
  intent: 0.2,
  routing: 0.2,
  trace: 0.1,
  boundary: 0.15,
  latency: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Per-axis evaluators
// ---------------------------------------------------------------------------

function scoreState(scenario: Scenario, finalState: SimulatorState): AxisScore {
  const exp = scenario.expectedFinalState;
  const notes: string[] = [];
  const checks: boolean[] = [];

  // Threads
  for (const expected of exp.threads) {
    const ok = matchThread(expected, finalState);
    checks.push(ok);
    if (!ok) {
      notes.push(
        `thread mismatch: expected ${JSON.stringify(expected)} in ${[...finalState.threads.values()].map((t) => `${t.id}:${t.status}`).join(", ") || "(none)"}`,
      );
    }
  }

  // Scheduled tasks
  for (const expected of exp.scheduledTasks) {
    const ok = finalState.scheduledTasks.some((t) => {
      const text = `${t.description ?? ""}`.toLowerCase();
      const ownerOk = !expected.owner || t.owner === expected.owner;
      const containsOk = (expected.descriptionContains ?? []).every((s) =>
        text.includes(s.toLowerCase()),
      );
      const excludesOk = (expected.descriptionExcludes ?? []).every(
        (s) => !text.includes(s.toLowerCase()),
      );
      return ownerOk && containsOk && excludesOk;
    });
    checks.push(ok);
    if (!ok) {
      notes.push(
        `scheduledTask mismatch: expected ${JSON.stringify(expected)}`,
      );
    }
  }

  // Replies per channel — count bounds and mustContain
  for (const [channel, spec] of Object.entries(exp.repliesByChannel)) {
    const count = finalState.countRepliesInChannel(channel);
    const inBounds = count >= spec.count.min && count <= spec.count.max;
    checks.push(inBounds);
    if (!inBounds) {
      notes.push(
        `reply count for ${channel}: got ${count}, expected ${spec.count.min}-${spec.count.max}`,
      );
    }
    if (spec.mustContain) {
      const allText = finalState
        .repliesInChannel(channel)
        .map((r) => r.text.toLowerCase())
        .join(" \n ");
      for (const needle of spec.mustContain) {
        const ok = allText.includes(needle.toLowerCase());
        checks.push(ok);
        if (!ok)
          notes.push(`reply in ${channel} missing required content: ${needle}`);
      }
    }
    if (spec.shortAck) {
      const replies = finalState.repliesInChannel(channel);
      const ok =
        replies.length === 0 || replies.every((r) => r.text.length <= 80);
      checks.push(ok);
      if (!ok)
        notes.push(
          `reply in ${channel} expected to be a short ack (<=80 chars)`,
        );
    }
  }

  // External side effects
  if (exp.externalSideEffects?.emailsSent !== undefined) {
    const ok =
      finalState.external.emailsSent === exp.externalSideEffects.emailsSent;
    checks.push(ok);
    if (!ok) {
      notes.push(
        `emailsSent: got ${finalState.external.emailsSent}, expected ${exp.externalSideEffects.emailsSent}`,
      );
    }
  }

  // Pending prompts
  if (exp.pendingPrompts) {
    for (const [id, expectedSpec] of Object.entries(exp.pendingPrompts)) {
      const p = finalState.pendingPrompts.get(id);
      if (!p) {
        checks.push(false);
        notes.push(`pendingPrompt ${id} missing from final state`);
        continue;
      }
      if (expectedSpec.resolved !== undefined) {
        const ok = p.resolved === expectedSpec.resolved;
        checks.push(ok);
        if (!ok)
          notes.push(
            `pendingPrompt ${id}: resolved=${p.resolved}, expected ${expectedSpec.resolved}`,
          );
      }
    }
  }

  const raw =
    checks.length === 0 ? 1 : checks.filter(Boolean).length / checks.length;
  return {
    raw,
    weight: AXIS_WEIGHTS.state,
    weighted: raw * AXIS_WEIGHTS.state,
    notes,
  };
}

function matchThread(
  expected: ExpectedThread,
  finalState: SimulatorState,
): boolean {
  if (expected.id) {
    const t = finalState.threads.get(expected.id);
    if (!t) return false;
    if (expected.status && t.status !== expected.status) return false;
    if (expected.instructionContains) {
      const text = t.instruction.toLowerCase();
      for (const needle of expected.instructionContains) {
        if (!text.includes(needle.toLowerCase())) return false;
      }
    }
    return true;
  }
  // Structural match
  const matching = [...finalState.threads.values()].filter((t) => {
    if (expected.ownerEq && t.owner !== expected.ownerEq) return false;
    if (expected.statusEq && t.status !== expected.statusEq) return false;
    if (expected.instructionContains) {
      const text = t.instruction.toLowerCase();
      for (const needle of expected.instructionContains) {
        if (!text.includes(needle.toLowerCase())) return false;
      }
    }
    if (expected.instructionExcludes) {
      const text = t.instruction.toLowerCase();
      for (const needle of expected.instructionExcludes) {
        if (text.includes(needle.toLowerCase())) return false;
      }
    }
    return true;
  });
  if (expected.count !== undefined) return matching.length === expected.count;
  return matching.length >= 1;
}

function scoreIntent(scenario: Scenario, trace: Trace): AxisScore {
  const expected = scenario.expectedTrace.intent;
  if (!expected) {
    return {
      raw: 1,
      weight: AXIS_WEIGHTS.intent,
      weighted: AXIS_WEIGHTS.intent,
      notes: [],
    };
  }
  const responses = trace.filter((e) => e.type === "stage1_response");
  if (responses.length === 0) {
    return {
      raw: 0,
      weight: AXIS_WEIGHTS.intent,
      weighted: 0,
      notes: ["no stage1_response trace events"],
    };
  }
  // For RESPOND intent: at least one stage1_response showed shouldRespond=RESPOND.
  // For IGNORE intent: all responses are IGNORE.
  const recordedIntents = responses
    .map((e) => (e.detail?.shouldRespond as string | undefined) ?? null)
    .filter(Boolean);
  const matches =
    expected === "RESPOND"
      ? recordedIntents.includes("RESPOND")
      : recordedIntents.every((v) => v === "IGNORE");
  return {
    raw: matches ? 1 : 0,
    weight: AXIS_WEIGHTS.intent,
    weighted: matches ? AXIS_WEIGHTS.intent : 0,
    notes: matches
      ? []
      : [
          `expected intent ${expected}, observed ${recordedIntents.join(",") || "(none)"}`,
        ],
  };
}

function scoreRouting(
  scenario: Scenario,
  finalState: SimulatorState,
): AxisScore {
  const notes: string[] = [];
  const checks: boolean[] = [];
  const expectedChannels = new Set(
    Object.keys(scenario.expectedFinalState.repliesByChannel),
  );
  // Every emitted reply must be in an expected channel.
  for (const r of finalState.replies) {
    const ok = expectedChannels.has(r.channel);
    checks.push(ok);
    if (!ok) notes.push(`reply emitted in unexpected channel '${r.channel}'`);
  }
  // Every channel with min>=1 must have replies.
  for (const [channel, spec] of Object.entries(
    scenario.expectedFinalState.repliesByChannel,
  )) {
    if (spec.count.min < 1) continue;
    const ok = finalState.countRepliesInChannel(channel) >= spec.count.min;
    checks.push(ok);
    if (!ok)
      notes.push(`channel ${channel} expected >=${spec.count.min} replies`);
  }
  const raw =
    checks.length === 0 ? 1 : checks.filter(Boolean).length / checks.length;
  return {
    raw,
    weight: AXIS_WEIGHTS.routing,
    weighted: raw * AXIS_WEIGHTS.routing,
    notes,
  };
}

function scoreTrace(scenario: Scenario, trace: Trace): AxisScore {
  const notes: string[] = [];
  const checks: boolean[] = [];

  const stage1 = trace.count("stage1_call");
  const stage1Ok =
    stage1 >= scenario.expectedTrace.stage1Calls.min &&
    stage1 <= scenario.expectedTrace.stage1Calls.max;
  checks.push(stage1Ok);
  if (!stage1Ok) {
    notes.push(
      `stage1Calls=${stage1}, expected ${scenario.expectedTrace.stage1Calls.min}-${scenario.expectedTrace.stage1Calls.max}`,
    );
  }

  if (scenario.expectedTrace.plannerCalls) {
    const planner = trace.count("planner_call");
    const ok =
      planner >= scenario.expectedTrace.plannerCalls.min &&
      planner <= scenario.expectedTrace.plannerCalls.max;
    checks.push(ok);
    if (!ok)
      notes.push(
        `plannerCalls=${planner}, expected ${scenario.expectedTrace.plannerCalls.min}-${scenario.expectedTrace.plannerCalls.max}`,
      );
  }

  if (scenario.expectedTrace.abortFired !== undefined) {
    const fired = trace.count("abort_fired") > 0;
    const ok = fired === scenario.expectedTrace.abortFired;
    checks.push(ok);
    if (!ok)
      notes.push(
        `abortFired=${fired}, expected ${scenario.expectedTrace.abortFired}`,
      );
  }

  if (scenario.expectedTrace.preemptMode) {
    const ev = trace.find((e) => e.type === "preempt");
    const ok = ev?.preemptMode === scenario.expectedTrace.preemptMode;
    checks.push(ok);
    if (!ok)
      notes.push(
        `preemptMode=${ev?.preemptMode ?? "(none)"}, expected ${scenario.expectedTrace.preemptMode}`,
      );
  }

  if (scenario.expectedTrace.threadOpsContains) {
    const observed = trace
      .filter((e) => e.type === "thread_op")
      .map((e) => (e.detail?.type as string | undefined) ?? "");
    for (const t of scenario.expectedTrace.threadOpsContains) {
      const ok = observed.includes(t);
      checks.push(ok);
      if (!ok)
        notes.push(
          `expected threadOp '${t}', observed ${observed.join(",") || "(none)"}`,
        );
    }
  }

  if (scenario.expectedTrace.threadOps) {
    for (const expectedOp of scenario.expectedTrace.threadOps) {
      const ok = trace.find((e) => {
        if (e.type !== "thread_op") return false;
        if (e.detail?.type !== expectedOp.type) return false;
        if (
          expectedOp.workThreadId &&
          e.detail?.workThreadId !== expectedOp.workThreadId
        )
          return false;
        return true;
      });
      checks.push(!!ok);
      if (!ok)
        notes.push(`expected threadOp matching ${JSON.stringify(expectedOp)}`);
    }
  }

  const raw =
    checks.length === 0 ? 1 : checks.filter(Boolean).length / checks.length;
  return {
    raw,
    weight: AXIS_WEIGHTS.trace,
    weighted: raw * AXIS_WEIGHTS.trace,
    notes,
  };
}

function scoreBoundary(
  scenario: Scenario,
  trace: Trace,
): { axis: AxisScore; violated: boolean } {
  const violations = trace.count("boundary_violation");
  const limit = scenario.expectedTrace.boundaryViolations;
  const ok = violations <= limit;
  const notes = ok
    ? []
    : [`boundaryViolations=${violations}, expected <=${limit}`];
  return {
    axis: {
      raw: ok ? 1 : 0,
      weight: AXIS_WEIGHTS.boundary,
      weighted: ok ? AXIS_WEIGHTS.boundary : 0,
      notes,
    },
    violated: !ok,
  };
}

function scoreLatency(trace: Trace): AxisScore {
  const llmDurations = trace
    .filter((e) => e.type === "stage1_response")
    .map((e) => e.detail?.llmLatencyMs)
    .filter((value): value is number => typeof value === "number");
  const durations: number[] = llmDurations.length > 0 ? llmDurations : [];
  let lastStart: TraceEvent | undefined;
  if (durations.length === 0) {
    for (const e of trace.all()) {
      if (e.type === "handler_start") lastStart = e;
      else if (e.type === "handler_end" && lastStart) {
        durations.push(e.t - lastStart.t);
        lastStart = undefined;
      }
    }
  }
  if (durations.length === 0) {
    return {
      raw: 1,
      weight: AXIS_WEIGHTS.latency,
      weighted: AXIS_WEIGHTS.latency,
      notes: ["no handler runs to measure"],
    };
  }
  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
  const p95Idx = Math.min(
    durations.length - 1,
    Math.floor(durations.length * 0.95),
  );
  const p95 = durations[p95Idx] ?? 0;
  const notes: string[] = [];
  const checks: boolean[] = [];
  const p50Ok = p50 < 800;
  checks.push(p50Ok);
  if (!p50Ok) notes.push(`p50=${p50}ms, expected <800ms`);
  const p95Ok = p95 < 3000;
  checks.push(p95Ok);
  if (!p95Ok) notes.push(`p95=${p95}ms, expected <3000ms`);
  const raw = checks.filter(Boolean).length / checks.length;
  return {
    raw,
    weight: AXIS_WEIGHTS.latency,
    weighted: raw * AXIS_WEIGHTS.latency,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scoreScenario(args: {
  scenario: Scenario;
  finalState: SimulatorState;
  trace: Trace;
  durationMs: number;
  judge?: { pass: boolean; reason: string };
}): ScenarioResult {
  const { scenario, finalState, trace, durationMs, judge } = args;
  const state = scoreState(scenario, finalState);
  const intent = scoreIntent(scenario, trace);
  const routing = scoreRouting(scenario, finalState);
  const traceAxis = scoreTrace(scenario, trace);
  const boundary = scoreBoundary(scenario, trace);
  const latency = scoreLatency(trace);
  const rawScore =
    state.weighted +
    intent.weighted +
    routing.weighted +
    traceAxis.weighted +
    boundary.axis.weighted +
    latency.weighted;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    weight: scenario.weight,
    axes: {
      state,
      intent,
      routing,
      trace: traceAxis,
      boundary: boundary.axis,
      latency,
    },
    rawScore,
    score: rawScore,
    boundaryViolated: boundary.violated,
    judge,
    trace: trace.all().slice(),
    durationMs,
  };
}

export function passTier(
  finalScore: number,
): "fail" | "70" | "82" | "90" | "95" {
  if (finalScore >= 95) return "95";
  if (finalScore >= 90) return "90";
  if (finalScore >= 82) return "82";
  if (finalScore >= 70) return "70";
  return "fail";
}
