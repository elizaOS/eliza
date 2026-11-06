/** Host readback of an unknown outcome; real SQLite journal, controlled actuator. */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InteractiveTaskRuntime } from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";

const ORIGIN = "https://example.org";
const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};

describe("interactive task readback", () => {
  it("records only the outcome a readback reports", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteInteractiveTaskStore(db);
    let clock = 1000;
    const runtime = new InteractiveTaskRuntime({
      owner,
      store,
      now: () => ++clock,
      actuator: {
        capabilities: ["browser.click"],
        async observe() {
          return {
            id: "view-1",
            pageId: "page",
            origin: ORIGIN,
            version: 1,
            inputRevision: 0,
            observedAt: clock,
          };
        },
        async execute() {
          throw new Error("Not used");
        },
        // A reply carries more than the outcome; none of it may steer the task.
        async reconcile() {
          return {
            status: "succeeded",
            evidenceRef: "readback-1",
            type: "cancel",
            operationId: "other",
          } as { status: "succeeded"; evidenceRef: string };
        },
      },
    });
    try {
      let task = runtime.create({
        id: "task-1",
        goalRef: "goal-1",
        authorization: {
          decisionId: "grant",
          policyRevision: "policy",
          state: "active",
          decidedAt: new Date(1000).toISOString(),
          revokedAt: null,
        },
        allowedCapabilities: ["browser.click"],
        allowedOrigins: [ORIGIN],
      });
      task = await runtime.observe(task.id, task.revision);
      const step = (transition: Parameters<typeof store.transition>[2]) => {
        task = store.transition(
          task.id,
          { owner, expectedRevision: task.revision, now: ++clock },
          transition,
        ).task;
      };
      step({
        type: "prepare",
        proposal: {
          id: "op-1",
          taskId: task.id,
          epoch: task.epoch,
          observationId: "view-1",
          observationVersion: 1,
          inputRevision: 0,
          targetRef: "button",
          capability: "browser.click",
          authorizationId: "grant",
          expiresAt: clock + 60_000,
        },
      });
      step({ type: "dispatch", operationId: "op-1" });
      step({ type: "result", operationId: "op-1", status: "unknown" });
      expect(task.status).toBe("blocked");

      const reconciled = await runtime.reconcile(
        task.id,
        task.revision,
        "op-1",
        async () => true,
      );
      expect(reconciled.status).toBe("paused");
      expect(reconciled.operations[0]).toEqual({
        proposal: task.operations[0].proposal,
        status: "succeeded",
        evidenceRef: "readback-1",
      });
      expect(runtime.events(task.id).events.at(-1)?.kind).toBe("reconcile");
    } finally {
      await runtime.settle();
      db.close();
    }
  });
});
