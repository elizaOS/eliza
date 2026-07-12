import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWorkDashboard,
  buildWorkViewEvaluation,
} from "../src/work-dashboard.js";

describe("work dashboard", () => {
  it("builds built-in and saved view snapshots over Eliza Work items", () => {
    const dashboard = buildWorkDashboard({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      workItems: [
        {
          id: "work:docs",
          repo: "elizaos/eliza",
          kind: "task",
          state: "blocked",
          title: "Blocked docs",
          ownerAgentId: "agent-docs",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:docs",
          labels: ["docs"],
          packages: ["docs"],
          updatedAt: "2026-07-07T00:01:00.000Z",
        },
        {
          id: "work:runtime",
          repo: "elizaos/eliza",
          kind: "task",
          state: "ready",
          title: "Runtime followup",
          ownerAgentId: "agent-runtime",
          packages: ["core"],
        },
      ],
      cycles: [
        {
          id: "cycle:elizaos/eliza:july",
          repo: "elizaos/eliza",
          title: "July",
          state: "active",
        },
      ],
      modules: [
        {
          id: "module:elizaos/eliza:docs",
          repo: "elizaos/eliza",
          title: "Docs",
          state: "active",
        },
      ],
      views: [
        {
          id: "view:elizaos/eliza:blocked-docs",
          repo: "elizaos/eliza",
          kind: "kanban",
          state: "active",
          title: "Blocked Docs",
          filters: {
            state: ["blocked"],
            packages: ["docs"],
          },
          query: "docs",
        },
      ],
    });

    assert.equal(dashboard.summary.workItems, 2);
    assert.equal(dashboard.summary.blocked, 1);
    assert.equal(dashboard.summary.ready, 1);
    assert.equal(dashboard.summary.savedViews, 1);
    assert.equal(dashboard.progress.summary.total, 2);

    const blocked = dashboard.views.builtIn.find(
      (view) => view.id === "builtin:blocked",
    );
    const saved = dashboard.views.saved[0];

    assert.deepEqual(blocked.itemIds, ["work:docs"]);
    assert.equal(saved.id, "view:elizaos/eliza:blocked-docs");
    assert.deepEqual(saved.itemIds, ["work:docs"]);
    assert.deepEqual(saved.cycleIds, ["cycle:elizaos/eliza:july"]);
    assert.deepEqual(saved.moduleIds, ["module:elizaos/eliza:docs"]);
    assert.equal(saved.progress.byState.blocked, 1);
  });

  it("evaluates a saved view into rows, columns, linked pages, and next actions", () => {
    const evaluation = buildWorkViewEvaluation({
      now: "2026-07-07T00:05:00.000Z",
      repo: "elizaos/eliza",
      view: {
        id: "view:elizaos/eliza:docs-board",
        repo: "elizaos/eliza",
        kind: "kanban",
        title: "Docs board",
        filters: {
          packages: ["docs"],
        },
        layout: {
          columns: [
            { id: "ready", title: "Ready" },
            { id: "in_progress", title: "In Progress" },
            { id: "blocked", title: "Blocked" },
          ],
        },
      },
      workItems: [
        {
          id: "work:docs-active",
          repo: "elizaos/eliza",
          kind: "task",
          state: "in_progress",
          title: "Document Work views",
          ownerAgentId: "agent-docs",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:docs",
          paths: ["docs/steward-runtime-model.md"],
          packages: ["docs"],
          labels: ["docs"],
        },
        {
          id: "work:docs-blocked",
          repo: "elizaos/eliza",
          kind: "task",
          state: "blocked",
          title: "Unblock docs screenshots",
          ownerAgentId: "agent-docs",
          packages: ["docs"],
        },
        {
          id: "work:runtime",
          repo: "elizaos/eliza",
          kind: "task",
          state: "ready",
          title: "Runtime cleanup",
          packages: ["core"],
        },
      ],
      cycles: [
        {
          id: "cycle:elizaos/eliza:july",
          repo: "elizaos/eliza",
          title: "July",
          state: "active",
        },
      ],
      modules: [
        {
          id: "module:elizaos/eliza:docs",
          repo: "elizaos/eliza",
          title: "Docs",
          state: "active",
        },
      ],
      pages: [
        {
          id: "page:docs-plan",
          repo: "elizaos/eliza",
          title: "Docs plan",
          kind: "agent_plan",
          state: "active",
          workItemId: "work:docs-active",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:docs",
        },
      ],
    });

    assert.equal(evaluation.computedAt, "2026-07-07T00:05:00.000Z");
    assert.equal(evaluation.view.id, "view:elizaos/eliza:docs-board");
    assert.equal(evaluation.summary.totalItems, 2);
    assert.equal(evaluation.summary.totalPages, 1);
    assert.deepEqual(
      evaluation.rows.map((row) => row.id),
      ["work:docs-active", "work:docs-blocked"],
    );
    assert.deepEqual(evaluation.rows[0].pageIds, ["page:docs-plan"]);
    assert.equal(evaluation.rows[0].cycle.title, "July");
    assert.equal(evaluation.rows[0].module.title, "Docs");
    assert.deepEqual(
      evaluation.pages.map((page) => page.id),
      ["page:docs-plan"],
    );
    assert.deepEqual(
      evaluation.columns.map((column) => [column.id, column.count]),
      [
        ["ready", 0],
        ["in_progress", 1],
        ["blocked", 1],
      ],
    );
    assert.ok(evaluation.nextActions.includes("triage_blocked_work"));
    assert.ok(evaluation.nextActions.includes("review_column_flow"));
    assert.ok(evaluation.nextActions.includes("read_linked_work_pages"));
  });
});
