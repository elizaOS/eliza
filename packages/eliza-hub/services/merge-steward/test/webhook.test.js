import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  assertForgejoWebhookSignature,
  normalizeForgejoWebhook,
  parseForgejoWebhook,
  validateForgejoWebhookSignature,
  WebhookSignatureError,
} from "../src/webhook.js";

const baseRepository = {
  id: 42,
  name: "eliza",
  full_name: "elizaos/eliza",
  private: true,
  default_branch: "develop",
  owner: {
    id: 7,
    login: "elizaos",
    username: "elizaos",
  },
};

const basePullRequest = {
  id: 99,
  number: 12,
  title: "Queue-friendly change",
  state: "open",
  merged: false,
  mergeable: true,
  html_url: "http://localhost:3000/elizaos/eliza/pulls/12",
  user: {
    id: 21,
    login: "agent-one",
    username: "agent-one",
  },
  base: {
    ref: "develop",
    sha: "base-sha",
    repo: baseRepository,
  },
  head: {
    ref: "agent/change",
    sha: "head-sha",
    repo: baseRepository,
  },
  labels: [
    {
      id: 1,
      name: "queue:ready",
      color: "0e8a16",
    },
  ],
};

test("validates Forgejo HMAC signature headers against the raw body", () => {
  const rawBody = JSON.stringify({ action: "opened", number: 12 });
  const secret = "local-test-secret";
  const signature = sign(rawBody, secret);

  assert.equal(
    validateForgejoWebhookSignature({
      headers: { "X-Forgejo-Signature": signature },
      body: rawBody,
      secret,
    }),
    true,
  );
});

test("validates GitHub-compatible SHA-256 signature headers", () => {
  const rawBody = Buffer.from(JSON.stringify({ action: "synchronized" }));
  const secret = "local-test-secret";
  const signature = `sha256=${sign(rawBody, secret)}`;

  assert.equal(
    validateForgejoWebhookSignature({
      headers: new Headers({ "X-Hub-Signature-256": signature }),
      body: rawBody,
      secret,
    }),
    true,
  );
});

test("rejects missing or mismatched webhook signatures", () => {
  const rawBody = JSON.stringify({ action: "opened" });
  const secret = "local-test-secret";

  assert.equal(
    validateForgejoWebhookSignature({
      headers: {},
      body: rawBody,
      secret,
    }),
    false,
  );

  assert.equal(
    validateForgejoWebhookSignature({
      headers: { "X-Forgejo-Signature": sign(rawBody, secret) },
      body: `${rawBody}\n`,
      secret,
    }),
    false,
  );

  assert.throws(
    () =>
      assertForgejoWebhookSignature({
        headers: { "X-Forgejo-Signature": sign(rawBody, secret) },
        body: `${rawBody}\n`,
        secret,
      }),
    WebhookSignatureError,
  );
});

test("parses and normalizes a signed pull request webhook", () => {
  const payload = {
    action: "opened",
    number: 12,
    repository: baseRepository,
    pull_request: basePullRequest,
    sender: {
      id: 21,
      login: "agent-one",
      username: "agent-one",
    },
  };
  const rawBody = JSON.stringify(payload);
  const secret = "local-test-secret";

  const event = parseForgejoWebhook({
    headers: {
      "X-Forgejo-Delivery": "delivery-1",
      "X-Forgejo-Event": "pull_request",
      "X-Forgejo-Signature": sign(rawBody, secret),
    },
    rawBody,
    secret,
  });

  assert.equal(event.type, "pull_request.opened");
  assert.equal(event.kind, "pull_request");
  assert.equal(event.deliveryId, "delivery-1");
  assert.equal(event.repository.fullName, "elizaos/eliza");
  assert.equal(event.pullRequest.number, 12);
  assert.equal(event.pullRequest.base.branch, "develop");
  assert.equal(event.pullRequest.head.sha, "head-sha");
  assert.deepEqual(
    event.labels.map((label) => label.name),
    ["queue:ready"],
  );
});

test("normalizes pull request sync event type headers", () => {
  const event = normalizeForgejoWebhook({
    headers: {
      "X-Forgejo-Event": "pull_request",
      "X-Forgejo-Event-Type": "pull_request_sync",
    },
    payload: {
      action: "synchronized",
      number: 12,
      commit_id: "new-head-sha",
      repository: baseRepository,
      pull_request: {
        ...basePullRequest,
        head: {
          ...basePullRequest.head,
          sha: "new-head-sha",
        },
      },
      sender: basePullRequest.user,
    },
  });

  assert.equal(event.type, "pull_request.synchronized");
  assert.equal(event.action, "synchronized");
  assert.equal(event.commitSha, "new-head-sha");
  assert.equal(event.forgejoEventType, "pull_request_sync");
});

test("normalizes pull request label updates", () => {
  const event = normalizeForgejoWebhook({
    headers: {
      "X-Forgejo-Event": "pull_request",
      "X-Forgejo-Event-Type": "pull_request_label",
    },
    payload: {
      action: "label_updated",
      number: 12,
      repository: baseRepository,
      pull_request: basePullRequest,
      changes: {
        labels: {
          added: [{ name: "risk:low" }],
          removed: [{ name: "queue:blocked" }],
        },
      },
      sender: basePullRequest.user,
    },
  });

  assert.equal(event.type, "pull_request_label.label_updated");
  assert.equal(event.kind, "pull_request_label");
  assert.deepEqual(
    event.labelChanges.added.map((label) => label.name),
    ["risk:low"],
  );
  assert.deepEqual(
    event.labelChanges.removed.map((label) => label.name),
    ["queue:blocked"],
  );
});

test("normalizes pull request review and comment events", () => {
  const reviewEvent = normalizeForgejoWebhook({
    headers: {
      "X-Forgejo-Event": "pull_request",
      "X-Forgejo-Event-Type": "pull_request_review_approved",
    },
    payload: {
      action: "reviewed",
      number: 12,
      repository: baseRepository,
      pull_request: basePullRequest,
      review: {
        id: 55,
        type: "approved",
        reviewer: { login: "maintainer" },
      },
      sender: { login: "maintainer" },
    },
  });

  const commentEvent = normalizeForgejoWebhook({
    headers: {
      "X-Forgejo-Event": "pull_request",
      "X-Forgejo-Event-Type": "pull_request_comment",
    },
    payload: {
      action: "created",
      is_pull: true,
      repository: baseRepository,
      issue: { number: 12, title: basePullRequest.title },
      pull_request: basePullRequest,
      comment: {
        id: 90,
        body: "Queue receipt",
        user: { login: "eliza-merge-steward" },
      },
      sender: { login: "eliza-merge-steward" },
    },
  });

  assert.equal(reviewEvent.type, "pull_request_review.approved");
  assert.equal(reviewEvent.review.reviewer.login, "maintainer");
  assert.equal(commentEvent.type, "pull_request_comment.created");
  assert.equal(commentEvent.comment.body, "Queue receipt");
});

test("preserves pull request body text for plan and receipt parsing", () => {
  const event = normalizeForgejoWebhook({
    headers: { "X-Forgejo-Event": "pull_request" },
    payload: {
      action: "opened",
      number: 12,
      repository: baseRepository,
      pull_request: {
        ...basePullRequest,
        body: "Fixes #12\n\n## Plan\nUpdate queue policy.\n\n## Agent Run\nrunId: run_12",
      },
      sender: { login: "agent-one" },
    },
  });

  assert.match(event.pullRequest.body, /## Agent Run/);
});

test("normalizes status and workflow events used by queue checks", () => {
  const statusEvent = normalizeForgejoWebhook({
    headers: { "X-Forgejo-Event": "status" },
    payload: {
      id: 100,
      sha: "head-sha",
      state: "success",
      context: "typecheck",
      description: "ok",
      target_url: "http://localhost:3000/elizaos/eliza/actions/runs/4",
      repository: baseRepository,
      sender: { login: "forgejo-actions" },
    },
  });

  const workflowEvent = normalizeForgejoWebhook({
    headers: { "X-Forgejo-Event": "workflow_run" },
    payload: {
      action: "completed",
      workflow: { name: "smoke" },
      workflow_run: {
        id: 4,
        conclusion: "success",
        head_sha: "head-sha",
      },
      pull_request: basePullRequest,
      repository: baseRepository,
      sender: { login: "forgejo-actions" },
    },
  });

  assert.equal(statusEvent.type, "status.success");
  assert.equal(statusEvent.status.context, "typecheck");
  assert.equal(statusEvent.commitSha, "head-sha");
  assert.equal(workflowEvent.type, "workflow_run.completed");
  assert.equal(workflowEvent.workflow.run.conclusion, "success");
  assert.equal(workflowEvent.pullRequest.number, 12);
});

function sign(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}
