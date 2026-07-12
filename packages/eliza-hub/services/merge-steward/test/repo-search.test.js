import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRepoSearch } from "../src/repo-search.js";

describe("repo search", () => {
  it("ranks queue items and supplied Actions logs from natural query text", () => {
    const search = buildRepoSearch({
      now: "2026-07-07T00:00:00.000Z",
      query: "capacitor bridge typecheck failed",
      repo: "elizaos/eliza",
      queueItems: [
        {
          id: "elizaos/eliza#15078",
          repo: "elizaos/eliza",
          pullRequestId: 15078,
          title: "fix: repair capacitor bridge post-merge CI",
          queueState: "blocked_checks",
          ownerAgentId: "agent-ci",
          targetBranch: "develop",
          changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
          affectedPackages: ["plugin-capacitor-bridge"],
          requiredChecks: ["typecheck"],
          checkResults: { typecheck: "failure" },
          nextActions: ["inspect_failed_test"],
        },
      ],
      documents: [
        {
          kind: "actions_log",
          id: "log-15078",
          repo: "elizaos/eliza",
          title: "capacitor bridge typecheck failed",
          body: "tsc failed in packages/plugin-capacitor-bridge/src/index.ts with a missing export.",
          metadata: {
            workflow: "CI",
          },
        },
        {
          kind: "issue",
          id: "issue-docs",
          repo: "elizaos/eliza",
          title: "Docs cleanup",
          body: "Update README examples.",
        },
      ],
    });

    assert.equal(search.summary.searchedDocuments, 3);
    assert.equal(search.summary.matchedDocuments, 2);
    assert.equal(search.results[0].kind, "actions_log");
    assert.equal(search.results[0].id, "log-15078");
    assert.ok(
      search.results.some((result) => result.id === "elizaos/eliza#15078"),
    );
    assert.equal(search.facets.kinds.actions_log, 1);
    assert.equal(search.facets.kinds.pull_request, 1);
    assert.ok(
      search.results[0].snippets.some((snippet) =>
        snippet.text.includes("capacitor bridge typecheck failed"),
      ),
    );
    assert.ok(search.labels.includes("search:matched"));
    assert.ok(search.labels.includes("search:actions-log"));
  });

  it("filters by kind and owner agent", () => {
    const search = buildRepoSearch({
      query: "runtime claim",
      ownerAgentId: "agent-runtime",
      kinds: ["claim"],
      claims: [
        {
          id: "claim-runtime",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-runtime",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          status: "active",
          paths: ["packages/core/src/runtime.ts"],
        },
        {
          id: "claim-docs",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-docs",
          resourceKind: "path",
          resourceId: "docs/readme.md",
          status: "active",
        },
      ],
    });

    assert.equal(search.summary.matchedDocuments, 1);
    assert.equal(search.results[0].id, "claim-runtime");
    assert.equal(search.results[0].kind, "claim");
    assert.equal(search.results[0].ownerAgentId, "agent-runtime");
  });

  it("indexes durable work items for agent intake search", () => {
    const search = buildRepoSearch({
      query: "docs blocked package",
      repo: "elizaos/eliza",
      kinds: ["work_item"],
      workItems: [
        {
          id: "work:elizaos/eliza:task:docs-intake",
          repo: "elizaos/eliza",
          kind: "task",
          state: "blocked",
          title: "Document agent package intake",
          summary: "Waiting on docs package owner review.",
          ownerAgentId: "agent-docs",
          paths: ["docs/steward-runtime-model.md"],
          packages: ["docs"],
          labels: ["docs", "blocked"],
        },
      ],
    });

    assert.equal(search.summary.matchedDocuments, 1);
    assert.equal(search.results[0].kind, "work_item");
    assert.equal(search.results[0].id, "work:elizaos/eliza:task:docs-intake");
    assert.equal(search.results[0].metadata.state, "blocked");
    assert.equal(search.facets.kinds.work_item, 1);
  });

  it("indexes work cycles and modules for planning search", () => {
    const search = buildRepoSearch({
      query: "runtime july hardening",
      repo: "elizaos/eliza",
      workCycles: [
        {
          id: "cycle:elizaos/eliza:july-hardening",
          repo: "elizaos/eliza",
          state: "active",
          title: "July agent hardening",
          ownerAgentId: "agent-lead",
        },
      ],
      workModules: [
        {
          id: "module:elizaos/eliza:runtime",
          repo: "elizaos/eliza",
          state: "active",
          title: "Runtime",
          summary: "Core runtime coordination",
          paths: ["packages/core"],
          packages: ["core"],
        },
      ],
    });

    assert.equal(search.summary.matchedDocuments, 2);
    assert.ok(search.results.some((result) => result.kind === "work_cycle"));
    assert.ok(search.results.some((result) => result.kind === "work_module"));
    assert.equal(search.facets.kinds.work_cycle, 1);
    assert.equal(search.facets.kinds.work_module, 1);
  });

  it("indexes saved work views for dashboard search", () => {
    const search = buildRepoSearch({
      query: "blocked docs dashboard",
      repo: "elizaos/eliza",
      kinds: ["work_view"],
      workViews: [
        {
          id: "view:elizaos/eliza:blocked-docs",
          repo: "elizaos/eliza",
          kind: "dashboard",
          state: "active",
          title: "Blocked docs dashboard",
          query: "docs blocked",
          filters: {
            state: ["blocked"],
            packages: ["docs"],
          },
        },
      ],
    });

    assert.equal(search.summary.matchedDocuments, 1);
    assert.equal(search.results[0].kind, "work_view");
    assert.equal(search.results[0].metadata.kind, "dashboard");
    assert.equal(search.facets.kinds.work_view, 1);
  });

  it("indexes durable work pages for agent plans and runbooks", () => {
    const search = buildRepoSearch({
      query: "steward docs runbook plan",
      repo: "elizaos/eliza",
      kinds: ["work_page"],
      workPages: [
        {
          id: "page:elizaos/eliza:work:work-elizaos-eliza-task-docs-intake:agent_plan",
          repo: "elizaos/eliza",
          kind: "agent_plan",
          state: "active",
          title: "Docs intake plan",
          summary: "Plan steward docs intake",
          body: "Runbook steps for updating the steward docs and linking the Work item.",
          ownerAgentId: "agent-docs",
          workItemId: "work:elizaos/eliza:task:docs-intake",
          tags: ["docs", "runbook"],
        },
      ],
    });

    assert.equal(search.summary.matchedDocuments, 1);
    assert.equal(search.results[0].kind, "work_page");
    assert.equal(search.results[0].metadata.kind, "agent_plan");
    assert.equal(
      search.results[0].metadata.workItemId,
      "work:elizaos/eliza:task:docs-intake",
    );
    assert.equal(search.facets.kinds.work_page, 1);
  });
});
