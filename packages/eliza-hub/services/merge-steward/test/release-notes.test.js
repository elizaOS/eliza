import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReleaseNotes } from "../src/release-notes.js";

describe("release notes", () => {
  it("groups merged PRs by release category and summarizes agent work", () => {
    const notes = buildReleaseNotes({
      repo: "elizaos/eliza",
      targetBranch: "develop",
      version: "2.1.0",
      now: "2026-07-07T00:00:00.000Z",
      items: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 10,
          title: "feat: add runtime queue receipts",
          authorKind: "agent",
          ownerAgentId: "agent-runtime",
          targetBranch: "develop",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T11:00:00.000Z",
          affectedPackages: ["core"],
          labels: ["feature"],
          risk: { level: "medium" },
          commitSummary: "Adds durable receipt metadata for queue execution.",
        },
        {
          repo: "elizaos/eliza",
          pullRequestId: 11,
          title: "fix: repair runner retry accounting",
          authorKind: "agent",
          ownerAgentId: "agent-ci",
          targetBranch: "develop",
          queueState: "merged",
          mergedAt: "2026-07-06T12:00:00.000Z",
          affectedPackages: ["plugin-ci"],
          labels: ["bug"],
          riskLevel: "low",
        },
        {
          repo: "elizaos/eliza",
          pullRequestId: 12,
          title: "docs: update deployment notes",
          authorKind: "human",
          targetBranch: "develop",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T13:00:00.000Z",
          changedFiles: ["docs/readiness.md"],
        },
        {
          repo: "elizaos/eliza",
          pullRequestId: 13,
          title: "feat: still open",
          authorKind: "agent",
          ownerAgentId: "agent-runtime",
          targetBranch: "develop",
          pullRequestMerged: false,
          affectedPackages: ["core"],
        },
      ],
    });

    assert.equal(notes.title, "Release 2.1.0");
    assert.equal(notes.summary.totalMergedPullRequests, 3);
    assert.equal(notes.summary.agentPullRequests, 2);
    assert.equal(notes.summary.humanPullRequests, 1);
    assert.equal(notes.validation.excludedItemCount, 1);
    assert.equal(notes.validation.excluded[0].reason, "not_merged");
    assert.deepEqual(
      notes.sections.map((section) => section.key),
      ["features", "fixes", "docs"],
    );
    assert.deepEqual(
      notes.packages.map((item) => item.packageName),
      ["core", "plugin-ci", "unscoped"],
    );
    assert.deepEqual(
      notes.agents.map((item) => item.ownerAgentId),
      ["agent-ci", "agent-runtime"],
    );
    assert.ok(notes.markdown.includes("## Features"));
    assert.ok(
      notes.markdown.includes(
        "feat: add runtime queue receipts (#10) (core) - agent-runtime",
      ),
    );
    assert.ok(
      notes.markdown.includes(
        "Adds durable receipt metadata for queue execution.",
      ),
    );
    assert.ok(notes.markdown.includes("## Agent Contributions"));
  });

  it("filters release windows by merged timestamps and reports missing evidence", () => {
    const notes = buildReleaseNotes({
      repo: "elizaos/eliza",
      from: "2026-07-06T00:00:00.000Z",
      to: "2026-07-07T00:00:00.000Z",
      items: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 20,
          title: "feat: inside window",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T05:00:00.000Z",
          labels: ["feature"],
        },
        {
          repo: "elizaos/eliza",
          pullRequestId: 21,
          title: "fix: before window",
          pullRequestMerged: true,
          mergedAt: "2026-07-05T23:59:00.000Z",
          labels: ["bug"],
        },
        {
          repo: "other/repo",
          pullRequestId: 22,
          title: "feat: wrong repo",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T05:00:00.000Z",
        },
        {
          repo: "elizaos/eliza",
          pullRequestId: 23,
          title: "feat: no timestamp",
          pullRequestMerged: true,
        },
      ],
    });

    assert.equal(notes.summary.totalMergedPullRequests, 1);
    assert.deepEqual(
      notes.sections[0].items.map((item) => item.pullRequestId),
      [20],
    );
    assert.deepEqual(
      notes.validation.excluded.map((item) => item.reason),
      ["before_range", "repo_mismatch", "missing_merged_timestamp_for_range"],
    );
    assert.ok(
      notes.validation.warnings.includes(
        "range_filter_skipped_items_without_merged_timestamps",
      ),
    );
    assert.equal(
      notes.validation.warnings.includes("unbounded_release_range"),
      false,
    );
  });
});
