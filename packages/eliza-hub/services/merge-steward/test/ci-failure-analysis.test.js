import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCiFailureAnalysis } from "../src/ci-failure-analysis.js";

describe("CI failure analysis", () => {
  it("classifies failed test logs and routes them to the owning agent", () => {
    const analysis = buildCiFailureAnalysis({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        id: "elizaos/eliza#42",
        repo: "elizaos/eliza",
        pullRequestId: 42,
        ownerAgentId: "agent-runtime",
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
      },
      checks: [
        {
          name: "unit",
          conclusion: "failure",
          log: [
            "TAP version 13",
            "not ok 7 - runtime handles queued messages",
            "AssertionError: Expected 1 Received 0",
          ].join("\n"),
        },
      ],
    });

    assert.equal(analysis.computedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(analysis.queueItem.id, "elizaos/eliza#42");
    assert.equal(analysis.summary.primaryCategory, "test_failure");
    assert.equal(analysis.summary.maxSeverity, "high");
    assert.equal(analysis.summary.retryable, false);
    assert.deepEqual(analysis.summary.categories, { test_failure: 1 });
    assert.equal(analysis.analyses[0].checkName, "unit");
    assert.equal(analysis.analyses[0].category, "test_failure");
    assert.equal(analysis.analyses[0].likelyOwnerAgentId, "agent-runtime");
    assert.deepEqual(analysis.analyses[0].impact.paths, [
      "packages/core/src/runtime.ts",
    ]);
    assert.equal(analysis.analyses[0].evidence[0].line, 2);
    assert.match(analysis.analyses[0].summary, /Route to agent-runtime/);
    assert.equal(analysis.recommendations[0].action, "inspect_failed_test");
  });

  it("prioritizes secrets and runner infrastructure above lower-severity failures", () => {
    const analysis = buildCiFailureAnalysis({
      ownerAgentId: "agent-ci",
      checks: [
        {
          name: "deploy",
          conclusion: "failure",
          log: "Error: missing required secret ELIZA_CLOUD_TOKEN",
        },
        {
          name: "docker-smoke",
          conclusion: "failure",
          log: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        },
        {
          name: "lint",
          conclusion: "failure",
          log: "eslint: no-unused-vars in src/index.ts",
        },
      ],
    });

    assert.equal(analysis.summary.primaryCategory, "secret_missing");
    assert.equal(analysis.summary.maxSeverity, "critical");
    assert.equal(analysis.summary.retryable, false);
    assert.equal(analysis.summary.requiresHuman, true);
    assert.deepEqual(analysis.summary.categories, {
      secret_missing: 1,
      runner_infra: 1,
      lint_failure: 1,
    });
    assert.deepEqual(
      analysis.recommendations.map((recommendation) => recommendation.category),
      ["secret_missing", "runner_infra", "lint_failure"],
    );
  });

  it("marks pure network flakes as retryable", () => {
    const analysis = buildCiFailureAnalysis({
      logs: [
        {
          name: "install",
          status: "failure",
          log: "request failed with ECONNRESET while downloading package tarball",
        },
      ],
    });

    assert.equal(analysis.summary.primaryCategory, "infra_flake");
    assert.equal(analysis.summary.retryable, true);
    assert.equal(analysis.analyses[0].retryable, true);
    assert.equal(analysis.analyses[0].suggestedActions[0], "retry_check");
  });
});
