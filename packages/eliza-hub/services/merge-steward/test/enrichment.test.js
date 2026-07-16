import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signAgentRunReceipt } from "../src/agent-run-receipt.js";
import { buildEnrichmentPatch, enrichQueueItem } from "../src/enrichment.js";

describe("Forgejo enrichment", () => {
  it("builds queue facts from pull request files reviews and statuses", () => {
    const patch = buildEnrichmentPatch({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        headSha: "head-sha",
      },
      pullRequest: pullRequest(),
      files: [
        { filename: "packages/core/src/index.ts", additions: 10, deletions: 4 },
        { filename: "README.md", changes: 3 },
      ],
      reviews: [
        {
          id: 1,
          state: "APPROVED",
          user: { login: "maintainer" },
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      statuses: [
        { context: "smoke", state: "success" },
        { context: "typecheck", state: "failure" },
      ],
      config: {
        protectedBranches: ["develop"],
      },
    });

    assert.equal(patch.targetProtected, true);
    assert.equal(patch.reviewSatisfied, true);
    assert.equal(patch.hasHumanApproval, true);
    assert.equal(patch.pullRequestState, "open");
    assert.equal(patch.pullRequestDraft, false);
    assert.equal(patch.pullRequestMerged, false);
    assert.equal(patch.pullRequestMergeable, true);
    assert.equal(patch.hasExecutionPlan, true);
    assert.equal(patch.hasValidationPlan, true);
    assert.equal(patch.changedLines, 17);
    assert.deepEqual(patch.changedFiles, [
      "packages/core/src/index.ts",
      "README.md",
    ]);
    assert.deepEqual(patch.requiredChecks, ["smoke", "typecheck"]);
    assert.deepEqual(patch.checkResults, {
      smoke: "success",
      typecheck: "failure",
    });
  });

  it("uses latest review state per reviewer", () => {
    const patch = buildEnrichmentPatch({
      item: { repo: "elizaos/eliza", pullRequestId: 12, headSha: "head-sha" },
      pullRequest: pullRequest(),
      reviews: [
        {
          id: 1,
          state: "APPROVED",
          user: { login: "maintainer" },
          submitted_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          state: "REQUEST_CHANGES",
          user: { login: "maintainer" },
          submitted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    assert.equal(patch.reviewSatisfied, false);
    assert.equal(patch.hasHumanApproval, false);
  });

  it("replaces stale stored review approval when live reviews request changes", () => {
    const patch = buildEnrichmentPatch({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        headSha: "head-sha",
        reviewSatisfied: true,
        hasHumanApproval: true,
      },
      pullRequest: pullRequest(),
      reviews: [
        {
          id: 1,
          state: "APPROVED",
          user: { login: "maintainer" },
          submitted_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          state: "REQUEST_CHANGES",
          user: { login: "maintainer" },
          submitted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    assert.equal(patch.reviewSatisfied, false);
    assert.equal(patch.hasHumanApproval, false);
  });

  it("replaces stale human approval when the latest live review is dismissed", () => {
    const patch = buildEnrichmentPatch({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        headSha: "head-sha",
        reviewSatisfied: true,
        hasHumanApproval: true,
      },
      pullRequest: pullRequest(),
      reviews: [
        {
          id: 1,
          state: "APPROVED",
          user: { login: "maintainer" },
          submitted_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          state: "DISMISSED",
          user: { login: "maintainer" },
          submitted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    assert.equal(patch.reviewSatisfied, false);
    assert.equal(patch.hasHumanApproval, false);
  });

  it("deduplicates statuses by context and prefers combined statuses", () => {
    const patch = buildEnrichmentPatch({
      item: { repo: "elizaos/eliza", pullRequestId: 12, headSha: "head-sha" },
      pullRequest: pullRequest(),
      statuses: [
        { context: "smoke", state: "failure" },
        { context: "smoke", state: "success" },
      ],
      combinedStatus: {
        statuses: [
          { context: "smoke", state: "success" },
          { context: "smoke", state: "failure" },
          { context: "lint", state: "skipped" },
          { state: "success" },
        ],
      },
    });

    assert.deepEqual(patch.requiredChecks, ["smoke", "lint"]);
    assert.deepEqual(patch.checkResults, { smoke: "success", lint: "skipped" });
  });

  it("verifies agent run receipts while refreshing pull request facts", () => {
    const receipt = {
      runId: "run_12",
      state: "succeeded",
      failedChildren: 0,
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    const signature = signAgentRunReceipt(receipt, "receipt-secret");
    const patch = buildEnrichmentPatch({
      item: { repo: "elizaos/eliza", pullRequestId: 12, headSha: "head-sha" },
      pullRequest: pullRequest({
        body: `Fixes #12

## Plan
Update queue policy.

## Validation
Run tests.

## Agent Run
runId: ${receipt.runId}
state: ${receipt.state}
failedChildren: ${receipt.failedChildren}
updatedAt: ${receipt.updatedAt}
signature: ${signature}`,
      }),
      config: {
        agentRunReceipt: {
          signatureSecret: "receipt-secret",
        },
      },
    });

    assert.equal(patch.agentRun.verified, true);
    assert.equal(patch.agentRun.verification.status, "verified");
  });

  it("paginates files reviews and statuses", async () => {
    const calls = [];
    const result = await enrichQueueItem({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        headSha: "head-sha",
      },
      config: {
        enabled: true,
        pageLimit: 2,
        maxPages: 3,
        protectedBranches: ["develop"],
      },
      client: {
        async getPullRequest() {
          return pullRequest();
        },
        async listPullRequestFiles(_repo, _number, query) {
          calls.push(["files", query.page, query.limit]);
          if (query.page === 1)
            return [
              { filename: "a.ts", additions: 1, deletions: 1 },
              { filename: "b.ts", changes: 2 },
            ];
          if (query.page === 2)
            return [{ filename: "c.ts", additions: 3, deletions: 0 }];
          return [];
        },
        async listPullRequestReviews(_repo, _number, query) {
          calls.push(["reviews", query.page, query.limit]);
          return query.page === 1
            ? [{ state: "APPROVED", user: { login: "maintainer" } }]
            : [];
        },
        async listCommitStatuses(_repo, _sha, query) {
          calls.push(["statuses", query.page, query.limit]);
          return query.page === 1
            ? [{ context: "smoke", state: "success" }]
            : [];
        },
        async getCombinedCommitStatus() {
          return null;
        },
      },
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.patch.changedFiles, ["a.ts", "b.ts", "c.ts"]);
    assert.equal(result.patch.changedLines, 7);
    assert.deepEqual(result.patch.checkResults, { smoke: "success" });
    assert.deepEqual(calls.map((call) => call.join(":")).sort(), [
      "files:1:2",
      "files:2:2",
      "reviews:1:2",
      "statuses:1:2",
    ]);
  });

  it("marks stale head shas and ignores statuses from the old sha", async () => {
    const statusCalls = [];
    const result = await enrichQueueItem({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        headSha: "old-sha",
        checkResults: { smoke: "success" },
      },
      config: {
        enabled: true,
        protectedBranches: ["develop"],
        requiredChecks: ["smoke"],
      },
      client: {
        async getPullRequest() {
          return pullRequest({ headSha: "new-sha" });
        },
        async listPullRequestFiles() {
          return [];
        },
        async listPullRequestReviews() {
          return [];
        },
        async listCommitStatuses() {
          statusCalls.push("called");
          return [{ context: "smoke", state: "success" }];
        },
        async getCombinedCommitStatus() {
          statusCalls.push("called");
          return { statuses: [{ context: "smoke", state: "success" }] };
        },
      },
    });

    assert.equal(result.patch.headSha, "new-sha");
    assert.equal(result.patch.headShaMatches, false);
    assert.deepEqual(result.patch.checkResults, {});
    assert.deepEqual(statusCalls, []);
  });

  it("skips without failing when the Forgejo client is unavailable", async () => {
    const result = await enrichQueueItem({
      item: { repo: "elizaos/eliza", pullRequestId: 12 },
      config: { enabled: true },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "forgejo_client_unconfigured");
  });
});

function pullRequest({
  headSha = "head-sha",
  body = "Fixes #12\n\n## Plan\nUpdate queue policy.\n\n## Validation\nRun merge-steward tests.",
  state = "open",
  draft = false,
  merged = false,
  mergeable = true,
} = {}) {
  return {
    number: 12,
    title: "task-agent-12: queue-friendly change",
    body,
    state,
    draft,
    merged,
    mergeable,
    user: { login: "agent-one" },
    base: { ref: "develop", sha: "base-sha" },
    head: { ref: "agent/change", sha: headSha },
    labels: [{ name: "agent:agent-one" }, { name: "queue:ready" }],
  };
}
