/** Exercises status-cache retry and replica updates with injected persistence boundaries; no cluster is required. */
import { expect, test } from "bun:test";
import type { Server } from "../crd/generated/server-v1alpha1";
import { DeploymentStatusTracker } from "../deployment-status";

test.each(["routing", "status"])(
  "retries unchanged status after failed %s persistence",
  async (failure) => {
    let fail = true;
    let routingWrites = 0;
    const persisted: Server["status"][] = [];
    const tracker = new DeploymentStatusTracker(
      async () => {
        routingWrites++;
        if (fail && failure === "routing")
          throw new Error("routing unavailable");
      },
      async (_name, _namespace, status) => {
        if (fail && failure === "status") throw new Error("status unavailable");
        persisted.push(status);
      },
    );
    await expect(tracker.update("agent", "eliza-agents", 2, 1)).rejects.toThrow(
      "unavailable",
    );
    expect(persisted).toHaveLength(0);
    fail = false;
    await tracker.update("agent", "eliza-agents", 2, 1);
    expect(persisted).toMatchObject([{ phase: "Running", replicas: 1 }]);
    await tracker.update("agent", "eliza-agents", 2, 1);
    expect(persisted).toHaveLength(1);
    expect(routingWrites).toBe(2);
  },
);

test("persists ready replica changes within a phase and clears deleted server state", async () => {
  const statuses: Server["status"][] = [];
  const tracker = new DeploymentStatusTracker(
    async () => {},
    async (_name, _namespace, status) => {
      statuses.push(status);
    },
  );
  await tracker.update("agent", "eliza-agents", 3, 1);
  await tracker.update("agent", "eliza-agents", 3, 2);
  expect(statuses).toMatchObject([
    { phase: "Running", replicas: 1 },
    { phase: "Running", replicas: 2 },
  ]);
  tracker.forget("agent", "eliza-agents");
  await tracker.update("agent", "eliza-agents", 3, 2);
  expect(statuses).toHaveLength(3);
});
