/** Validates task-widget snapshots from deterministic durable task DTOs. */

import { describe, expect, it } from "vitest";
import type { TaskThreadDto } from "../services/orchestrator-task-mapper.js";
import { buildOrchestratorWidgetSnapshot } from "../services/orchestrator-widget-contract.js";
import { CODING_AGENT_ROUTE_PATHS } from "../setup-routes.js";

function task(overrides: Partial<TaskThreadDto>): TaskThreadDto {
  return {
    id: "task-1",
    title: "Implement runtime orchestration",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "do the thing",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: "sess-1",
    latestSessionLabel: "claude",
    latestSessionModel: "claude-fable-5",
    latestAccountProviderId: "anthropic-subscription",
    latestAccountId: "acct-1",
    latestAccountLabel: "Claude Pro",
    parentTaskId: null,
    latestWorkdir: "/repo",
    latestRepo: "elizaOS/eliza",
    projectId: null,
    latestActivityAt: 1,
    decisionCount: 2,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:01:00.000Z",
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("orchestrator widget contract", () => {
  it("emits compact v1 task payloads with UI statuses and evidence links", () => {
    const snapshot = buildOrchestratorWidgetSnapshot(
      [
        task({
          admission: { state: "queued", position: 2, enqueuedAt: "now" },
        }),
      ],
      new Date("2026-07-12T00:02:00.000Z"),
    );

    expect(snapshot.version).toBe("orchestrator.widgets.v1");
    expect(snapshot.generatedAt).toBe("2026-07-12T00:02:00.000Z");
    expect(snapshot.totalTaskCount).toBe(1);
    expect(snapshot.tasks[0]).toMatchObject({
      taskId: "task-1",
      label: "Implement runtime orchestration",
      status: "queued",
      model: "claude-fable-5",
      account: {
        providerId: "anthropic-subscription",
        accountId: "acct-1",
        label: "Claude Pro",
      },
      progressSummary: "Queued at position 2",
    });
    expect(snapshot.tasks[0]?.evidenceLinks.map((link) => link.label)).toEqual([
      "details",
      "events",
      "stream",
    ]);
  });

  it("maps waiting and terminal task states for floating widgets", () => {
    const snapshot = buildOrchestratorWidgetSnapshot([
      task({ id: "needs", status: "waiting_on_user", activeSessionCount: 0 }),
      task({
        id: "done",
        status: "done",
        closedAt: "2026-07-12T00:03:00.000Z",
      }),
      task({ id: "failed", status: "failed" }),
      task({ id: "archived", status: "archived" }),
    ]);

    expect(snapshot.tasks.map((t) => [t.taskId, t.status])).toEqual([
      ["needs", "needs_input"],
      ["done", "completed"],
      ["failed", "failed"],
      ["archived", "completed"],
    ]);
  });
});

describe("orchestrator widget lineage", () => {
  it("populates parentTaskId and childTaskIds from list rows", () => {
    const snapshot = buildOrchestratorWidgetSnapshot([
      task({ id: "parent" }),
      task({ id: "child", parentTaskId: "parent" }),
    ]);

    expect(
      snapshot.tasks.find((t) => t.taskId === "parent")?.childTaskIds,
    ).toEqual(["child"]);
    expect(snapshot.tasks.find((t) => t.taskId === "child")?.parentTaskId).toBe(
      "parent",
    );
  });

  it("derives stable lineage from the complete task set outside the visible bound", () => {
    const parent = task({ id: "parent" });
    const snapshot = buildOrchestratorWidgetSnapshot(
      [parent],
      new Date("2026-07-12T00:02:00.000Z"),
      [
        parent,
        task({ id: "child-z", parentTaskId: "parent" }),
        task({ id: "child-a", parentTaskId: "parent" }),
      ],
    );

    expect(snapshot.totalTaskCount).toBe(3);
    expect(snapshot.tasks[0]?.childTaskIds).toEqual(["child-a", "child-z"]);
  });
});

it("registers snapshot and stream routes with the plugin dispatcher", () => {
  expect(CODING_AGENT_ROUTE_PATHS).toEqual(
    expect.arrayContaining([
      { type: "GET", path: "/api/orchestrator/widgets" },
      { type: "GET", path: "/api/orchestrator/widgets/stream" },
    ]),
  );
});
