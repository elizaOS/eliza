/** Child host for real kill/restart journal qualification. No browser or provider. */
import { Database } from "bun:sqlite";
import { InteractiveTaskRuntime } from "../../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../../src/services/interactive-task-store.ts";

const [databasePath, mode] = process.argv.slice(2);
if (!databasePath || !["dispatch", "recover"].includes(mode))
  throw new Error("Expected database path and mode");
const db = new Database(databasePath);
db.exec("PRAGMA synchronous = FULL");
const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};
const runtime = new InteractiveTaskRuntime({
  owner,
  store: new SqliteInteractiveTaskStore(db),
  actuator: {
    capabilities: ["fill"],
    async observe() {
      return {
        id: "view-1",
        pageId: "page-1",
        version: 1,
        inputRevision: 0,
        origin: "https://example.org",
        observedAt: Date.now(),
      };
    },
    async execute(_proposal, context) {
      if (!context.isCurrent()) throw new Error("Unexpected stale dispatch");
      process.stdout.write(
        `${JSON.stringify({ phase: "dispatched", status: runtime.get("task-1").operations[0].status })}\n`,
      );
      // Parent kills this real process while the adapter has not returned a result.
      setInterval(() => {}, 1000);
      return new Promise<never>(() => {});
    },
  },
});
if (mode === "recover") {
  const task = runtime.get("task-1");
  process.stdout.write(
    `${JSON.stringify({ phase: "recovered", status: task.status, operation: task.operations[0].status, epoch: task.epoch, events: runtime.events(task.id).events.map((event) => ({ id: event.eventId, kind: event.kind })) })}\n`,
  );
  db.close();
} else {
  runtime.create({
    id: "task-1",
    goalRef: "goal-1",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      decidedAt: new Date().toISOString(),
      state: "active",
      revokedAt: null,
    },
    allowedCapabilities: ["fill"],
    allowedOrigins: ["https://example.org"],
  });
  const task = await runtime.observe("task-1", 0);
  await runtime.execute("task-1", task.revision, {
    id: "operation-1",
    taskId: "task-1",
    epoch: task.epoch,
    observationId: "view-1",
    observationVersion: 1,
    inputRevision: 0,
    targetRef: "target-1",
    capability: "fill",
    authorizationId: "grant",
    expiresAt: Date.now() + 10000,
  });
}
