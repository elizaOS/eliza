import { describe, expect, it, vi } from "vitest";
import type {
  TaskRunResult,
  TaskRunSpec,
} from "../../src/services/smithers-task-types";

// Mock the durable runner so this test never spawns a per-task Bun subprocess.
// We only care about the EXACT spec the integration layer forwards — i.e. the
// config the production caller (actions/tasks.ts -> runPromptViaSmithers ->
// runDurableTask) gets today. Pinning it here makes any future drift visible.
const runTaskWithSmithers = vi.fn(
  async (spec: TaskRunSpec): Promise<TaskRunResult> => ({
    taskId: spec.taskId,
    runId: spec.runId,
    status: "completed",
    turns: 1,
    approved: true,
    agentsDone: [true],
    metrics: { turns: 1, agents: 1, retries: 0, durationMs: 0 },
  }),
);

vi.mock("../../src/services/smithers-task-runner", () => ({
  runTaskWithSmithers,
}));

// Imported AFTER vi.mock so the integration module binds the mocked runner.
const { runDurableTask } = await import(
  "../../src/services/smithers-task-integration"
);

/**
 * REGRESSION / WIRING PIN — production single-turn Smithers config.
 *
 * The production path that drives a durable coding task is:
 *   actions/tasks.ts: runCreate
 *     -> runPromptViaSmithers(service, session, task, timeoutMs, model)
 *       -> runDurableTask(service, session, task, { timeoutMs, model })
 *
 * Note what runPromptViaSmithers does NOT pass: maxTurns, provision, submit,
 * approvalBeforeSubmit, or parallelAgents. So today the durable graph is built
 * single-turn (maxTurns: 1, no provision/approval/submit, one agent), which is
 * the deliberate behaviour-preserving drop-in for the old direct-prompt path.
 *
 * These tests assert the EXACT TaskRunSpec the integration layer forwards when
 * called the way production calls it. If a future change starts forwarding a
 * round-trip cap as maxTurns, or wires up provision/submit/parallel agents,
 * one of these assertions will fail and force an explicit, reviewed update —
 * exactly the visibility this pin exists to provide.
 *
 * KNOWN GAP (documented, intentionally NOT changed here): the multi-step
 * durable graph (provision -> agent-turn loop -> approval -> submit, with
 * parallel fan-out) is fully built + unit-tested in smithers-task-runner.ts,
 * but the production caller hardcodes a single turn and none of the optional
 * steps. Wiring the existing per-session round-trip cap (sub-agent-router's
 * DEFAULT_ROUND_TRIP_CAP) through as maxTurns lives in a different service and
 * would change live agent behaviour, so it requires real-LLM trajectory
 * evidence before it ships — out of scope for this conservative pin.
 */
describe("smithers production wiring (single-turn config pin)", () => {
  it("forwards exactly { taskId=runId=sessionId, initialPrompt, maxTurns:1 } and nothing else", async () => {
    runTaskWithSmithers.mockClear();
    const sendPrompt = vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "done",
    }));
    const session = { sessionId: "sess-prod-pin" };

    // Call shaped exactly like runPromptViaSmithers in actions/tasks.ts:
    // only timeoutMs + model are passed (both may be undefined).
    await runDurableTask({ sendPrompt }, session, "do the work", {
      timeoutMs: 60_000,
      model: "claude",
    });

    expect(runTaskWithSmithers).toHaveBeenCalledTimes(1);
    const spec = runTaskWithSmithers.mock.calls[0]?.[0] as TaskRunSpec;

    // runId === taskId === sessionId — the session id is the durable resume key.
    expect(spec.taskId).toBe(session.sessionId);
    expect(spec.runId).toBe(session.sessionId);
    expect(spec.initialPrompt).toBe("do the work");

    // The single-turn pin: production hardcodes one turn.
    expect(spec.maxTurns).toBe(1);

    // The multi-step graph features are NOT wired by the production caller.
    expect(spec.provision).toBeUndefined();
    expect(spec.submit).toBeUndefined();
    expect(spec.approvalBeforeSubmit).toBeUndefined();
    expect(spec.parallelAgents).toBeUndefined();
  });

  it("still defaults to maxTurns:1 when the caller passes no maxTurns (production omits it)", async () => {
    runTaskWithSmithers.mockClear();
    const sendPrompt = vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "ok",
    }));

    // Production never supplies maxTurns; assert the integration default is 1.
    await runDurableTask({ sendPrompt }, { sessionId: "s2" }, "task", {});

    const spec = runTaskWithSmithers.mock.calls[0]?.[0] as TaskRunSpec;
    expect(spec.maxTurns).toBe(1);
  });

  it("an explicit maxTurns would flow through (proves the cap is plumbable, just not wired today)", async () => {
    runTaskWithSmithers.mockClear();
    const sendPrompt = vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "ok",
    }));

    // This is the opt-in path a future change would use to forward a real cap;
    // it is exercised here only to document that the seam already exists.
    await runDurableTask({ sendPrompt }, { sessionId: "s3" }, "task", {
      maxTurns: 32,
    });

    const spec = runTaskWithSmithers.mock.calls[0]?.[0] as TaskRunSpec;
    expect(spec.maxTurns).toBe(32);
  });
});
