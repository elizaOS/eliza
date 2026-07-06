/**
 * Drives every concrete scheduled-task primitive (goal, todo, message_triage, reminder,
 * checkin, followup, recap, approval) through the real scheduled-task runner: fire,
 * clock-advance with structural completion, and permanent-failure preserved as a domain
 * artifact.
 */
import { describe, expect, it } from "vitest";
import type { LifeOpsScheduledPrimitive } from "./helpers/lifeops-scheduled-task-simulation.js";
import {
  createLifeOpsScheduledTaskSimulationHarness,
  SIMULATED_RENDERED_DISPATCH_MESSAGE,
} from "./helpers/lifeops-scheduled-task-simulation.js";

const PRIMITIVES: LifeOpsScheduledPrimitive[] = [
  "goal",
  "todo",
  "message_triage",
  "reminder",
  "checkin",
  "followup",
  "recap",
  "approval",
];

describe("LifeOps scheduled-task simulation harness", () => {
  it("fires each concrete primitive through the real scheduled-task runner", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();

    const tasks = [];
    for (const primitive of PRIMITIVES) {
      tasks.push(
        await h.schedulePrimitive(primitive, {
          output: {
            destination: "channel",
            target: `${primitive}:owner`,
            persistAs: "task_metadata",
          },
          completionCheck:
            primitive === "checkin" ? { kind: "user_acknowledged" } : undefined,
          metadata:
            primitive === "goal" ? { callerMetadata: "preserved" } : undefined,
        }),
      );
    }

    for (const task of tasks) {
      const fired = await h.firePrimitive(task);
      expect(fired.state.status).toBe("fired");
      expect(fired.metadata?.lastDispatchResult).toMatchObject({ ok: true });
    }

    expect(h.dispatches).toHaveLength(PRIMITIVES.length);
    expect(h.dispatches.map((entry) => entry.metadata?.primitive)).toEqual(
      PRIMITIVES,
    );
    expect(h.dispatches.map((entry) => entry.channelKey)).toEqual(PRIMITIVES);
    expect(h.dispatches[0]?.metadata).toMatchObject({
      callerMetadata: "preserved",
      primitive: "goal",
    });
    for (const entry of h.dispatches) {
      expect(entry.result).toMatchObject({
        ok: true,
        messageId: `sim_${entry.taskId}`,
      });
    }
  });

  it("advances clock and completes fired tasks through structural checks", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    const checkin = await h.schedulePrimitive("checkin", {
      completionCheck: { kind: "user_acknowledged" },
    });
    await h.firePrimitive(checkin);

    h.advanceMinutes(5);
    const completed = await h.runner.evaluateCompletion(checkin.taskId, {
      acknowledged: true,
    });

    expect(completed.state.status).toBe("completed");
    expect(completed.state.completedAt).toBe(h.nowIso());

    const log = await h.logStore.list({
      agentId: "pa-simulation-agent",
      taskId: checkin.taskId,
    });
    expect(log.map((row) => row.transition)).toEqual([
      "scheduled",
      "fire_attempt",
      "fired",
      "completed",
    ]);
  });

  it("fails the task on a permanent DispatchResult failure and preserves it as a domain artifact", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    h.setDispatchResult({
      ok: false,
      reason: "auth_expired",
      message: "owner grant expired",
      userActionable: true,
    });

    const triage = await h.schedulePrimitive("message_triage", {
      // Empty escalation ladder (priority low): the permanent failure is
      // terminal on the first attempt. With rungs remaining the enforced
      // dispatch policy ADVANCES the ladder instead (surface_degraded) —
      // see plugin-scheduling's dispatch-policy-enforcement suite.
      priority: "low",
      output: {
        destination: "channel",
        target: "slack:owner",
        persistAs: "task_metadata",
      },
    });
    const fired = await h.firePrimitive(triage);

    // #11041/#10993: a returned `{ ok: false }` with no retry step remaining
    // is a permanent failure — the row must NOT be recorded as `fired`.
    expect(fired.state.status).toBe("failed");
    expect(fired.state.lastDecisionLog).toBe(
      "dispatch_failed: auth_expired: owner grant expired",
    );
    expect(fired.metadata?.lastDispatchResult).toEqual({
      ok: false,
      reason: "auth_expired",
      message: "owner grant expired",
      userActionable: true,
    });
    expect(fired.metadata?.lastDispatchError).toEqual({
      name: "DispatchResultError",
      message: "auth_expired: owner grant expired",
    });
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.result).toEqual(fired.metadata?.lastDispatchResult);

    const log = await h.logStore.list({
      agentId: "pa-simulation-agent",
      taskId: triage.taskId,
    });
    // The claim-time "fired" transition stays in the trail; the appended
    // "failed" entry records the dispatch outcome (matches runner.test.ts).
    expect(log.map((row) => row.transition)).toEqual([
      "scheduled",
      "fire_attempt",
      "fired",
      "failed",
    ]);
  });

  it("reschedules the same step on a transient DispatchResult failure", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    h.setDispatchResult({
      ok: false,
      reason: "rate_limited",
      message: "429 from connector",
      retryAfterMinutes: 7,
      userActionable: false,
    });

    const triage = await h.schedulePrimitive("message_triage", {
      output: {
        destination: "channel",
        target: "slack:owner",
        persistAs: "task_metadata",
      },
    });
    const retried = await h.firePrimitive(triage);

    // #11041/#10993: `retryAfterMinutes > 0` is a transient failure — the row
    // goes back to `scheduled` with `firedAt` pushed past the backoff, the
    // escalation ladder is not advanced, and the enforced policy records a
    // bounded retry continuation (attempt 1 of the per-step budget).
    expect(retried.state.status).toBe("scheduled");
    expect(retried.state.firedAt).toBe(
      new Date(new Date(h.nowIso()).getTime() + 7 * 60_000).toISOString(),
    );
    expect(retried.state.lastDecisionLog).toBe(
      "dispatch retry 1/3 in 7m (rate_limited)",
    );
    expect(retried.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 7,
    });
    expect(retried.metadata?.pendingDispatch).toEqual({
      stepIndex: -1,
      attempt: 1,
    });
    expect(h.dispatches).toHaveLength(1);

    const log = await h.logStore.list({
      agentId: "pa-simulation-agent",
      taskId: triage.taskId,
    });
    expect(log.map((row) => row.transition)).toEqual([
      "scheduled",
      "fire_attempt",
      "fired",
      "dispatch_retried",
    ]);
  });

  it("drives the PA production dispatcher into a simulated real connector", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness({
      useProductionConnectorDispatcher: true,
    });
    const reminder = await h.schedulePrimitive("reminder", {
      output: {
        destination: "channel",
        target: "discord:owner-room",
        persistAs: "task_metadata",
      },
    });

    const fired = await h.firePrimitive(reminder);

    expect(fired.state.status).toBe("fired");
    expect(fired.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: `sim_${reminder.taskId}`,
    });
    expect(h.connectorSends).toHaveLength(1);
    // The connector receives the model-rendered message; the task's
    // instruction-voice `promptInstructions` only ever reaches the model
    // prompt, never the wire.
    expect(h.connectorSends[0]?.payload).toMatchObject({
      target: "owner-room",
      message: SIMULATED_RENDERED_DISPATCH_MESSAGE,
      metadata: {
        taskId: reminder.taskId,
      },
    });
    expect(h.modelPrompts).toHaveLength(1);
    expect(h.modelPrompts[0]).toContain(reminder.promptInstructions);
    expect(h.connectorSends[0]?.result).toEqual(
      fired.metadata?.lastDispatchResult,
    );
  });
});
