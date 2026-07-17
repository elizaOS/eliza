import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateMergePolicy, renderQueueComment } from "../src/index.js";

describe("queue comments", () => {
  it("renders a concise queued comment", () => {
    const decision = evaluateMergePolicy({
      authorKind: "human",
      targetProtected: true,
      reviewSatisfied: true,
      headShaMatches: true,
      changedLines: 12,
      changedFiles: ["README.md"],
      requiredChecks: ["smoke"],
      checkResults: { smoke: "success" },
    });

    const comment = renderQueueComment({
      decision,
      integrationBranch: "eliza-queue/develop/42",
    });

    assert.match(comment, /Eliza Merge Steward: queued/);
    assert.match(comment, /State: ready/);
    assert.match(comment, /Integration branch: eliza-queue\/develop\/42/);
  });

  it("renders blockers and required actions", () => {
    const decision = evaluateMergePolicy({
      authorKind: "agent",
      agentKnown: false,
      targetProtected: false,
      reviewSatisfied: false,
      headShaMatches: true,
      changedLines: 12,
      changedFiles: ["README.md"],
      requiredChecks: ["smoke"],
      checkResults: { smoke: "failure" },
    });

    const comment = renderQueueComment({ decision });

    assert.match(comment, /Eliza Merge Steward: blocked/);
    assert.match(comment, /unknown_agent/);
    assert.match(comment, /register_agent_identity/);
  });
});
