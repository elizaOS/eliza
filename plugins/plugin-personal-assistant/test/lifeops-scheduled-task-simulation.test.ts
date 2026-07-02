import { describe, expect, it } from "vitest";
import type { LifeOpsScheduledPrimitive } from "./helpers/lifeops-scheduled-task-simulation.js";
import { createLifeOpsScheduledTaskSimulationHarness } from "./helpers/lifeops-scheduled-task-simulation.js";

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

  it("preserves typed DispatchResult failures as domain artifacts", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    h.setDispatchResult({
      ok: false,
      reason: "auth_expired",
      message: "owner grant expired",
      userActionable: true,
    });

    const triage = await h.schedulePrimitive("message_triage", {
      output: {
        destination: "channel",
        target: "slack:owner",
        persistAs: "task_metadata",
      },
    });
    const fired = await h.firePrimitive(triage);

    // #11041 (#10721 H2): a typed {ok:false} dispatch is now recorded as
    // "failed", NOT "fired" — recording a failed connector send as "fired" was
    // silent message loss that the retry/backoff policy could never see. The
    // typed DispatchResult is still preserved on metadata as the domain artifact.
    expect(fired.state.status).toBe("failed");
    expect(fired.metadata?.lastDispatchResult).toEqual({
      ok: false,
      reason: "auth_expired",
      message: "owner grant expired",
      userActionable: true,
    });
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.result).toEqual(fired.metadata?.lastDispatchResult);
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
    expect(h.connectorSends[0]?.payload).toMatchObject({
      target: "owner-room",
      message: "Simulated reminder scheduled task",
      metadata: {
        taskId: reminder.taskId,
      },
    });
    expect(h.connectorSends[0]?.result).toEqual(
      fired.metadata?.lastDispatchResult,
    );
  });
});
