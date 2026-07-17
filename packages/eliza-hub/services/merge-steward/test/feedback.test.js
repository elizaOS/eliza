import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyForgejoFeedback,
  buildForgejoFeedback,
  isManagedFeedbackLabel,
  labelsForDecision,
  skipFeedbackReason,
} from "../src/feedback.js";
import { QUEUE_STATES } from "../src/policy.js";

describe("Forgejo feedback", () => {
  it("plans only steward-owned label changes and preserves agent identity labels", () => {
    const feedback = buildForgejoFeedback({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        labels: [
          "queue:ready",
          "risk:low",
          "agent:agent-one",
          "human-approved",
        ],
      },
      decision: {
        state: QUEUE_STATES.WAITING_FOR_REVIEW,
        blockers: ["review_required"],
        requiredActions: ["maintainer_review"],
        risk: { level: "medium" },
      },
      comment: "Eliza Merge Steward: blocked\n",
      event: { kind: "pull_request", actor: { login: "agent-one" } },
      config: { stewardUsername: "eliza-merge-steward" },
    });

    assert.equal(feedback.valid, true);
    assert.deepEqual(feedback.repo, { owner: "elizaos", repo: "eliza" });
    assert.deepEqual(feedback.addLabels, [
      "queue:blocked",
      "risk:medium",
      "agent:needs-human",
    ]);
    assert.deepEqual(feedback.removeLabels, ["queue:ready", "risk:low"]);
    assert.equal(isManagedFeedbackLabel("agent:agent-one"), false);
  });

  it("skips comment events and events created by the steward user", () => {
    assert.equal(
      skipFeedbackReason({ kind: "pull_request_comment" }),
      "comment_event",
    );
    assert.equal(
      skipFeedbackReason(
        { kind: "pull_request", actor: { login: "eliza-merge-steward" } },
        { stewardUsername: "eliza-merge-steward" },
      ),
      "steward_originated_event",
    );

    const feedback = buildForgejoFeedback({
      item: { repo: "elizaos/eliza", pullRequestId: 12 },
      decision: { state: QUEUE_STATES.READY },
      comment: "ready",
      event: { kind: "pull_request_comment" },
    });

    assert.equal(feedback.valid, false);
    assert.equal(feedback.reason, "comment_event");
  });

  it("supports dry-run output without a Forgejo client", async () => {
    const feedback = buildForgejoFeedback({
      item: { repo: "elizaos/eliza", pullRequestId: 12, labels: [] },
      decision: { state: QUEUE_STATES.READY, risk: { level: "low" } },
      comment: "Eliza Merge Steward: queued\n",
      event: { kind: "pull_request" },
    });

    const result = await applyForgejoFeedback({ feedback, dryRun: true });

    assert.equal(result.enabled, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.operations, [
      { type: "add_labels", labels: ["queue:ready", "risk:low"] },
      { type: "create_comment" },
    ]);
  });

  it("applies live label/comment operations and avoids duplicate comments", async () => {
    const calls = [];
    const feedback = buildForgejoFeedback({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        labels: ["queue:blocked"],
      },
      decision: { state: QUEUE_STATES.READY, risk: { level: "low" } },
      comment: "Eliza Merge Steward: queued\n",
      event: { kind: "pull_request" },
    });
    const client = {
      async removeIssueLabel(repo, issueNumber, label) {
        calls.push(["remove", repo, issueNumber, label]);
      },
      async addIssueLabels(repo, issueNumber, labels) {
        calls.push(["add", repo, issueNumber, labels]);
      },
      async listIssueComments(repo, issueNumber) {
        calls.push(["list-comments", repo, issueNumber]);
        return [{ body: "Eliza Merge Steward: queued\n" }];
      },
      async createIssueComment(repo, issueNumber, body) {
        calls.push(["comment", repo, issueNumber, body]);
      },
    };

    const result = await applyForgejoFeedback({
      client,
      feedback,
      dryRun: false,
    });

    assert.deepEqual(calls, [
      ["remove", { owner: "elizaos", repo: "eliza" }, 12, "queue:blocked"],
      [
        "add",
        { owner: "elizaos", repo: "eliza" },
        12,
        ["queue:ready", "risk:low"],
      ],
      ["list-comments", { owner: "elizaos", repo: "eliza" }, 12],
    ]);
    assert.equal(result.applied.at(-1).reason, "duplicate_comment");
  });

  it("returns invalid feedback for malformed queue items", () => {
    assert.equal(
      buildForgejoFeedback({
        item: { repo: "not/a/valid/repo", pullRequestId: 12 },
        decision: { state: QUEUE_STATES.READY },
      }).reason,
      "invalid_repo",
    );
  });

  it("maps decisions to queue and risk labels", () => {
    assert.deepEqual(
      labelsForDecision({
        state: QUEUE_STATES.BLOCKED_STALE,
        blockers: ["stale_target"],
        risk: { level: "high" },
      }),
      ["queue:blocked", "risk:high", "agent:stale"],
    );
  });

  it("mirrors steward-owned agent owner and claim labels", () => {
    const feedback = buildForgejoFeedback({
      item: {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        ownerAgentId: "agent-two",
        labels: [
          "agent-owner:agent-old",
          "agent:agent-one",
          "agent:stale-claim",
          "queue:blocked",
        ],
      },
      claims: [
        {
          repo: "elizaos/eliza",
          resourceKind: "pull_request",
          resourceId: "12",
          ownerAgentId: "agent-two",
          status: "active",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      ],
      decision: {
        state: QUEUE_STATES.READY,
        risk: { level: "low" },
      },
      event: { kind: "pull_request" },
    });

    assert.equal(feedback.valid, true);
    assert.ok(feedback.addLabels.includes("agent-owner:agent-two"));
    assert.ok(feedback.addLabels.includes("agent:claimed"));
    assert.ok(feedback.removeLabels.includes("agent-owner:agent-old"));
    assert.ok(feedback.removeLabels.includes("agent:stale-claim"));
    assert.equal(feedback.removeLabels.includes("agent:agent-one"), false);
    assert.equal(isManagedFeedbackLabel("agent-owner:agent-old"), true);
    assert.equal(isManagedFeedbackLabel("agent:agent-one"), false);
  });

  it("mirrors steward-owned submission gate labels and ignores arbitrary gate labels", () => {
    const labels = labelsForDecision(
      {
        state: QUEUE_STATES.READY,
        risk: { level: "low" },
      },
      {
        submissionGate: {
          decision: { state: "throttled" },
          labels: [
            "submission:blocked",
            "queue:flood-blocked",
            "agent:queue-throttled",
            "validation:broad-blocked",
            "reservation:missing",
            "agent:unreserved-work",
            "rate:blocked",
            "agent:rate-throttled",
            "branch:namespace-mismatch",
            "agent:branch-unowned",
            "risk:critical",
            "agent-owner:other",
            "user-custom-label",
          ],
        },
      },
    );

    assert.deepEqual(labels, [
      "queue:ready",
      "risk:low",
      "agent-submit:throttled",
      "queue:flood-blocked",
      "agent:queue-throttled",
      "validation:broad-blocked",
      "reservation:missing",
      "agent:unreserved-work",
      "rate:blocked",
      "agent:rate-throttled",
      "branch:namespace-mismatch",
      "agent:branch-unowned",
    ]);
    assert.equal(isManagedFeedbackLabel("validation:broad-blocked"), true);
    assert.equal(isManagedFeedbackLabel("reservation:missing"), true);
    assert.equal(isManagedFeedbackLabel("branch:namespace-mismatch"), true);
    assert.equal(isManagedFeedbackLabel("agent:queue-throttled"), true);
    assert.equal(isManagedFeedbackLabel("rate:blocked"), true);
    assert.equal(isManagedFeedbackLabel("agent:rate-throttled"), true);
    assert.equal(isManagedFeedbackLabel("user-custom-label"), false);
  });

  it("marks expired active claims as stale claim labels", () => {
    assert.ok(
      labelsForDecision(
        { state: QUEUE_STATES.READY },
        {
          claims: [
            {
              ownerAgentId: "agent-one",
              status: "active",
              expiresAt: "2000-01-01T00:00:00.000Z",
            },
          ],
        },
      ).includes("agent:stale-claim"),
    );
  });
});
