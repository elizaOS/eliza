import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { QUEUE_STATES } from "../src/policy.js";
import { MergeSteward } from "../src/steward.js";
import { InMemoryQueueStore } from "../src/store.js";

describe("merge steward orchestration", () => {
  afterEach(() => {
    delete process.env.STEWARD_TEST_SECRET;
    delete process.env.STEWARD_RECEIPT_SECRET;
  });

  it("keeps webhook delivery accepted when Forgejo feedback fails", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_FEEDBACK_ENABLED: "true",
      FORGEJO_FEEDBACK_DRY_RUN: "false",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      feedbackClient: {
        async removeIssueLabel() {
          throw new Error("Forgejo unavailable");
        },
      },
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.item.id, "elizaos/eliza#12");
    assert.equal(result.feedback.skipped, true);
    assert.equal(result.feedback.reason, "forgejo_feedback_failed");
    assert.match(result.feedback.error.message, /Forgejo unavailable/);
  });

  it("reports the feedback pass as failed when the claim lookup breaks", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_FEEDBACK_ENABLED: "true",
      FORGEJO_FEEDBACK_DRY_RUN: "true",
    });
    const store = new InMemoryQueueStore();
    store.listAgentClaims = async () => {
      throw new Error("claims table unavailable");
    };
    const steward = new MergeSteward({ config, store, logger: silentLogger });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    // A broken lookup must surface as a failed feedback pass, never as
    // feedback computed from a fabricated "no claims" result.
    assert.equal(result.accepted, true);
    assert.equal(result.feedback.skipped, true);
    assert.equal(result.feedback.reason, "forgejo_feedback_failed");
    assert.match(result.feedback.error.message, /claims table unavailable/);
  });

  it("treats duplicate webhook delivery ids as idempotent no-ops", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_FEEDBACK_ENABLED: "true",
      FORGEJO_FEEDBACK_DRY_RUN: "true",
    });
    const store = new InMemoryQueueStore();
    const steward = new MergeSteward({ config, store, logger: silentLogger });
    const rawBody = JSON.stringify(pullRequestPayload());
    const headers = signedHeaders(rawBody, {
      "x-forgejo-delivery": "delivery-pr-12",
      "x-forgejo-event": "pull_request",
    });

    const first = await steward.handleWebhookDelivery({ headers, rawBody });
    const duplicate = await steward.handleWebhookDelivery({ headers, rawBody });
    const events = await store.listEvents();

    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, undefined);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.reason, "duplicate_delivery");
    assert.equal(duplicate.item.id, "elizaos/eliza#12");
    assert.equal(duplicate.feedback.reason, "duplicate_delivery");
    assert.equal(events.length, 1);
    assert.equal((await store.listQueueItems()).length, 1);
  });

  it("mirrors stored agent claims into Forgejo feedback labels", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_FEEDBACK_ENABLED: "true",
      FORGEJO_FEEDBACK_DRY_RUN: "true",
    });
    const store = new InMemoryQueueStore();
    await store.claimAgentWork({
      repo: "elizaos/eliza",
      resourceKind: "pull_request",
      resourceId: "12",
      ownerAgentId: "agent-one",
      paths: ["README.md"],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    const steward = new MergeSteward({ config, store, logger: silentLogger });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });
    const addOperation = result.feedback.operations.find(
      (operation) => operation.type === "add_labels",
    );

    assert.equal(result.accepted, true);
    assert.ok(addOperation.labels.includes("agent-owner:agent-one"));
    assert.ok(addOperation.labels.includes("agent:claimed"));
  });

  it("can require Forgejo webhook delivery ids", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(pullRequestPayload());

    await assert.rejects(
      steward.handleWebhookDelivery({
        headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
        rawBody,
      }),
      /delivery id is required/,
    );
  });

  it("records but does not mutate queue state for gated webhook events", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/runtime",
    });
    const store = new InMemoryQueueStore();
    const steward = new MergeSteward({
      config,
      store,
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, {
        "x-forgejo-delivery": "delivery-gated-pr-12",
        "x-forgejo-event": "pull_request",
      }),
      rawBody,
    });
    const events = await store.listEvents();

    assert.equal(result.accepted, true);
    assert.equal(result.gated, true);
    assert.equal(result.reason, "repository_not_allowed");
    assert.equal(events.length, 1);
    assert.equal(events[0].gate.reason, "repository_not_allowed");
    assert.equal((await store.listQueueItems()).length, 0);
  });

  it("blocks closed pull requests observed through webhooks", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(
      pullRequestPayload({
        pullRequest: {
          state: "closed",
          merged: false,
        },
      }),
    );

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    assert.equal(result.item.pullRequestState, "closed");
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.state, QUEUE_STATES.CLOSED);
    assert.ok(result.decision.blockers.includes("pull_request_closed"));
  });

  it("blocks unsigned agent run receipts when verified receipts are required", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    process.env.STEWARD_RECEIPT_SECRET = "receipt-secret";
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV: "STEWARD_RECEIPT_SECRET",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(
      pullRequestPayload({
        pullRequest: {
          body: "Fixes #12\n\n## Plan\nUpdate queue policy.\n\n## Validation\nRun tests.\n\n## Agent Run\nrunId: run_12\nstate: succeeded\nfailedChildren: 0",
        },
      }),
    );

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    assert.equal(result.item.agentRun.verified, false);
    assert.equal(result.item.agentRun.verification.status, "unsigned");
    assert.equal(result.decision.allowed, false);
    assert.ok(
      result.decision.blockers.includes("unverified_agent_run_receipt"),
    );
  });

  it("ignores caller-supplied items during live integration execution", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      integrationClient: integrationClient(calls),
      logger: silentLogger,
    });

    const result = await steward.executeIntegration([readyItem()], {
      confirmed: true,
    });

    assert.equal(result.plan.planCount, 0);
    assert.equal(result.execution.skipped, true);
    assert.equal(result.execution.reason, "no_ready_items");
    assert.deepEqual(calls, []);
  });

  it("uses persisted queue items instead of request-body items during live execution", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({ pullRequestId: 12, headSha: "head-sha-12" }),
    );
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: integrationClient(calls, {
        currentHeadSha: "head-sha-12",
      }),
      logger: silentLogger,
    });

    const result = await steward.executeIntegration(
      [readyItem({ pullRequestId: 99, headSha: "head-sha-99" })],
      { confirmed: true },
    );

    assert.equal(result.plan.planCount, 1);
    assert.equal(result.plan.plans[0].pullRequestId, 12);
    assert.equal(result.execution.executions[0].pullRequestId, 12);
    assert.equal(
      calls.some((call) => call[1]?.plan?.pullRequestId === 99),
      false,
    );
  });

  it("still allows caller-supplied items for dry-run integration planning", async () => {
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "true",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      logger: silentLogger,
    });

    const result = await steward.executeIntegration(
      [readyItem({ pullRequestId: 77 })],
      { confirmed: true },
    );

    assert.equal(result.plan.planCount, 1);
    assert.equal(result.plan.plans[0].pullRequestId, 77);
    assert.equal(result.execution.dryRun, true);
    assert.equal(result.execution.executions[0].status, "planned");
  });

  it("claims only policy-ready queue items from persisted state", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(readyItem({ pullRequestId: 41, priority: 2 }));
    await store.upsertQueueItem(readyItem({ pullRequestId: 43, priority: 1 }));
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 42,
        priority: 10,
        hasExecutionPlan: false,
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const claimed = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });
    const blockedByLane = await steward.claimNextQueueItem({
      workerId: "worker-two",
    });
    const stored = await store.getQueueItem("elizaos/eliza#41");

    assert.equal(claimed.claimed, true);
    assert.equal(claimed.item.id, "elizaos/eliza#41");
    assert.equal(claimed.item.queueState, "running");
    assert.equal(claimed.item.claimedBy, "worker-one");
    assert.equal(stored.queueState, "running");
    assert.equal(blockedByLane.claimed, false);
    assert.equal(blockedByLane.reason, "repo_or_target_busy");
  });

  it("does not claim stacked child PRs until their parents have merged", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 81,
        sourceBranch: "agent/stack/root",
        targetBranch: "develop",
        priority: 1,
      }),
    );
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 82,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        priority: 10,
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const before = await steward.listQueue();
    const first = await steward.claimNextQueueItem({ workerId: "worker-one" });
    await steward.finishQueueItem("elizaos/eliza#81", {
      state: QUEUE_STATES.MERGED,
    });
    const second = await steward.claimNextQueueItem({ workerId: "worker-two" });

    assert.deepEqual(
      before.scheduled.map((item) => item.id),
      ["elizaos/eliza#81"],
    );
    assert.equal(first.claimed, true);
    assert.equal(first.item.id, "elizaos/eliza#81");
    assert.equal(second.claimed, true);
    assert.equal(second.item.id, "elizaos/eliza#82");
  });

  it("evaluates single stacked PRs against persisted queue context", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 83,
        sourceBranch: "agent/stack/root",
        targetBranch: "develop",
        priority: 1,
      }),
    );
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 84,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        priority: 10,
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const blocked = await steward.evaluateItem(
      readyItem({
        pullRequestId: 84,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        priority: 10,
      }),
    );
    await steward.finishQueueItem("elizaos/eliza#83", {
      state: QUEUE_STATES.MERGED,
    });
    const allowed = await steward.evaluateItem(
      readyItem({
        pullRequestId: 84,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        priority: 10,
      }),
    );

    assert.equal(blocked.allowed, false);
    assert.ok(blocked.blockers.includes("stack_dependency_pending"));
    assert.equal(blocked.stackDependency.state, "waiting_on_stack");
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.stackDependency.state, "ready_in_stack");
  });

  it("runs one claimed queue item through a durable integration saga", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(readyItem({ pullRequestId: 44 }));
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: integrationClient(calls),
      logger: silentLogger,
    });

    const result = await steward.runQueueOnce({
      workerId: "queue-worker",
      confirmed: true,
    });
    const runs = await store.listRuns({ queueItemId: "elizaos/eliza#44" });
    const nodes = await store.listRunNodes(result.run.id);
    const attempts = await store.listAttempts({ runId: result.run.id });
    const events = await store.listRunEvents(result.run.id);

    assert.equal(result.claimed, true);
    assert.equal(result.item.queueState, QUEUE_STATES.MERGED);
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.attempt.status, "succeeded");
    assert.equal(result.plan.planCount, 1);
    assert.equal(result.execution.executions[0].status, "executed");
    assert.equal(runs.length, 1);
    assert.deepEqual(
      nodes.map((node) => [node.nodeId, node.status]),
      [
        ["integration", "succeeded"],
        ["queue_claim", "succeeded"],
      ],
    );
    assert.equal(attempts.length, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "QueueItemClaimed",
        "QueueItemBuildingIntegration",
        "IntegrationActionStarted",
        "IntegrationActionFinished",
        "IntegrationActionStarted",
        "IntegrationActionFinished",
        "IntegrationActionStarted",
        "IntegrationActionFinished",
        "IntegrationActionStarted",
        "IntegrationActionFinished",
        "QueueItemMerged",
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type.startsWith("IntegrationAction"))
        .map((event) => [
          event.type,
          event.payload.actionIndex,
          event.payload.actionType,
          event.payload.status,
        ]),
      [
        ["IntegrationActionStarted", 1, "ensure_integration_branch", null],
        [
          "IntegrationActionFinished",
          1,
          "ensure_integration_branch",
          "executed",
        ],
        ["IntegrationActionStarted", 2, "merge_pr_head_into_integration", null],
        [
          "IntegrationActionFinished",
          2,
          "merge_pr_head_into_integration",
          "executed",
        ],
        ["IntegrationActionStarted", 3, "wait_for_checks", null],
        ["IntegrationActionFinished", 3, "wait_for_checks", "executed"],
        ["IntegrationActionStarted", 4, "merge_original_pull_request", null],
        [
          "IntegrationActionFinished",
          4,
          "merge_original_pull_request",
          "executed",
        ],
      ],
    );
    assert.ok(calls.some((call) => call[0] === "mergeOriginalPullRequest"));
  });

  it("does not finalize a queue item after losing its active run fence", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(readyItem({ pullRequestId: 49 }));
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: {
        async ensureIntegrationBranch(input) {
          calls.push(["ensureIntegrationBranch", input]);
          return { ok: true };
        },
        async mergePullRequestHeadIntoIntegration(input) {
          calls.push(["mergePullRequestHeadIntoIntegration", input]);
          return { ok: true };
        },
        async waitForIntegrationChecks(input) {
          calls.push(["waitForIntegrationChecks", input]);
          return { ok: true };
        },
        async getPullRequest(repo, number) {
          calls.push(["getPullRequest", { repo, number }]);
          return {
            number,
            state: "open",
            merged: false,
            base: { ref: "develop" },
            head: { sha: "head-sha-12" },
          };
        },
        async mergeOriginalPullRequest(input) {
          calls.push(["mergeOriginalPullRequest", input]);
          const current = await store.getQueueItem("elizaos/eliza#49");
          await store.upsertQueueItem({
            ...current,
            activeRunId: "run:elizaos/eliza#49:attempt:reclaimed",
            claimedBy: "worker-new",
            updatedAt: "2026-07-06T00:01:00.000Z",
          });
          return { ok: true };
        },
      },
      logger: silentLogger,
    });

    const result = await steward.runQueueOnce({
      workerId: "queue-worker",
      confirmed: true,
      now: "2026-07-06T00:00:00.000Z",
    });
    const item = await store.getQueueItem("elizaos/eliza#49");
    const events = await store.listRunEvents(result.run.id);

    assert.equal(result.claimed, true);
    assert.equal(result.item.queueState, QUEUE_STATES.BUILDING_INTEGRATION);
    assert.equal(
      result.item.activeRunId,
      "run:elizaos/eliza#49:attempt:reclaimed",
    );
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.lastError, "queue_item_fence_lost");
    assert.equal(result.attempt.status, "failed");
    assert.equal(item.queueState, QUEUE_STATES.BUILDING_INTEGRATION);
    assert.equal(item.claimedBy, "worker-new");
    assert.equal(events.at(-1).type, "QueueItemFinalizationSkipped");
  });

  it("runs a claimed merge train through the durable worker path", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_BATCHING: "true",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 54,
        headSha: "head-sha-54",
        changedFiles: ["packages/core/src/a.ts"],
      }),
    );
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 55,
        sourceBranch: "agent/change-two",
        headSha: "head-sha-55",
        changedFiles: ["packages/client/src/b.ts"],
      }),
    );
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: integrationClient(calls, {
        currentHeadSha: {
          54: "head-sha-54",
          55: "head-sha-55",
        },
      }),
      logger: silentLogger,
    });

    const result = await steward.runQueueOnce({
      workerId: "queue-worker",
      confirmed: true,
    });

    assert.equal(result.claimed, true);
    assert.equal(result.plan.planCount, 2);
    assert.equal(result.execution.strategy, "merge-train");
    assert.deepEqual(
      result.items.map((item) => item.queueState),
      [QUEUE_STATES.MERGED, QUEUE_STATES.MERGED],
    );
    assert.deepEqual(
      result.runs.map((run) => run.status),
      ["succeeded", "succeeded"],
    );
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.status),
      ["succeeded", "succeeded"],
    );
    assert.deepEqual(
      calls
        .filter((call) => call[0] === "mergeOriginalPullRequest")
        .map((call) => call[1].plan.pullRequestId),
      [54, 55],
    );
  });

  it("releases unattempted merge train successors when a predecessor fails", async () => {
    const calls = [];
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_BATCHING: "true",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 64,
        headSha: "head-sha-64",
        changedFiles: ["packages/core/src/a.ts"],
      }),
    );
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 65,
        sourceBranch: "agent/change-two",
        headSha: "head-sha-65",
        changedFiles: ["packages/client/src/b.ts"],
      }),
    );
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: integrationClient(calls, {
        currentHeadSha: {
          64: "head-sha-64",
          65: "head-sha-65",
        },
        failAction: "waitForIntegrationChecks",
      }),
      logger: silentLogger,
    });

    const result = await steward.runQueueOnce({
      workerId: "queue-worker",
      confirmed: true,
    });
    const successorEvents = await store.listRunEvents(result.runs[1].id);

    assert.equal(result.claimed, true);
    assert.deepEqual(
      result.execution.executions.map((execution) => execution.status),
      ["failed", "blocked"],
    );
    assert.deepEqual(
      result.items.map((item) => item.queueState),
      [QUEUE_STATES.FAILED, QUEUE_STATES.QUEUED],
    );
    assert.equal(result.items[1].lastError, "merge_train_predecessor_failed");
    assert.equal(result.runs[1].status, "failed");
    assert.equal(successorEvents.at(-1).type, "QueueItemTrainBlocked");
    assert.equal(
      calls.some((call) => call[1]?.plan?.pullRequestId === 65),
      false,
    );
  });

  it("fails the durable integration saga when execution is blocked", async () => {
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(readyItem({ pullRequestId: 45 }));
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const result = await steward.runQueueOnce({
      workerId: "queue-worker",
      confirmed: true,
    });
    const nodes = await store.listRunNodes(result.run.id);

    assert.equal(result.claimed, true);
    assert.equal(result.item.queueState, QUEUE_STATES.FAILED);
    assert.equal(result.item.lastError, "integration_executor_unconfigured");
    assert.equal(result.run.status, "failed");
    assert.equal(result.attempt.status, "failed");
    assert.equal(
      nodes.find((node) => node.nodeId === "integration").status,
      "failed",
    );
  });

  it("does not claim queue work when durable execution is not confirmed", async () => {
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(readyItem({ pullRequestId: 46 }));
    const steward = new MergeSteward({
      config,
      store,
      integrationClient: integrationClient([]),
      logger: silentLogger,
    });

    const result = await steward.runQueueOnce({ workerId: "queue-worker" });
    const item = await store.getQueueItem("elizaos/eliza#46");

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "integration_execution_not_confirmed");
    assert.equal(item.queueState, undefined);
    assert.equal((await store.listRuns()).length, 0);
  });

  it("recovers stale active queue work and makes the lane claimable again", async () => {
    const old = "2026-07-06T00:00:00.000Z";
    const now = "2026-07-06T00:05:00.000Z";
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    const runId = "run:elizaos/eliza#74:attempt:1";
    await store.upsertQueueItem({
      ...readyItem({
        pullRequestId: 74,
        queueState: QUEUE_STATES.BUILDING_INTEGRATION,
        claimedBy: "dead-worker",
        claimedAt: old,
        activeRunId: runId,
        attemptCount: 1,
        updatedAt: old,
      }),
    });
    await store.upsertRun({
      id: runId,
      queueItemId: "elizaos/eliza#74",
      repo: "elizaos/eliza",
      pullRequestId: 74,
      targetBranch: "develop",
      status: "running",
      ownerKind: "steward",
      ownerId: "dead-worker",
      startedAt: old,
      heartbeatAt: old,
      updatedAt: old,
    });
    await store.upsertRunNode({
      runId,
      nodeId: "integration",
      queueItemId: "elizaos/eliza#74",
      status: "running",
      startedAt: old,
      updatedAt: old,
    });
    const attempt = await store.startAttempt({
      runId,
      nodeId: "integration",
      ownerId: "dead-worker",
      status: "running",
      startedAt: old,
      heartbeatAt: old,
      updatedAt: old,
    });
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const recovery = await steward.recoverStaleQueueItems({
      workerId: "worker-new",
      now,
      staleAfterMs: 60000,
    });
    const item = await store.getQueueItem("elizaos/eliza#74");
    const run = await store.getRun(runId);
    const node = (await store.listRunNodes(runId)).find(
      (entry) => entry.nodeId === "integration",
    );
    const failedAttempt = await store.getAttempt(attempt.id);
    const events = await store.listRunEvents(runId);
    const claim = await steward.claimNextQueueItem({
      workerId: "worker-new",
      now,
    });

    assert.equal(recovery.count, 1);
    assert.equal(item.queueState, QUEUE_STATES.QUEUED);
    assert.equal(item.claimedBy, null);
    assert.equal(item.claimedAt, null);
    assert.equal(item.activeRunId, null);
    assert.equal(item.lastError, "stale_queue_item_recovered");
    assert.equal(run.status, "failed");
    assert.equal(run.lastError, "stale_queue_item_recovered");
    assert.equal(node.status, "failed");
    assert.equal(failedAttempt.status, "failed");
    assert.equal(failedAttempt.lastError.message, "stale_queue_item_recovered");
    assert.equal(events.at(-1).type, "QueueItemRecovered");
    assert.equal(claim.claimed, true);
    assert.equal(claim.item.id, "elizaos/eliza#74");
    assert.equal(claim.item.attemptCount, 2);
  });

  it("applies persisted repository policy before queue scheduling", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertRepoPolicy({
      repo: "elizaos/eliza",
      queueMode: "serialized",
      protectedBranches: ["develop"],
      requiredChecks: ["typecheck"],
      trustedActors: ["agent-one"],
    });
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 52,
        targetProtected: false,
        agentKnown: false,
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const before = await steward.listQueue();
    const blockedClaim = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 52,
        targetProtected: false,
        agentKnown: false,
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success", typecheck: "success" },
      }),
    );
    const claimed = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    assert.deepEqual(before.items[0].requiredChecks, ["typecheck", "smoke"]);
    assert.equal(before.items[0].targetProtected, true);
    assert.equal(before.items[0].agentKnown, true);
    assert.equal(before.items[0].policySnapshot.queueMode, "serialized");
    assert.equal(before.scheduled.length, 0);
    assert.equal(blockedClaim.claimed, false);
    assert.equal(blockedClaim.reason, "no_ready_items");
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.item.id, "elizaos/eliza#52");
    assert.deepEqual(claimed.item.requiredChecks, ["typecheck", "smoke"]);
  });

  it("blocks strict agent queue claims until work reservations cover the PR", async () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 82,
        changedFiles: ["README.md"],
        workReservation: {
          state: "blocked",
          missingFiles: ["README.md"],
        },
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const blockedQueue = await steward.listQueue();
    const blockedDecision = await steward.evaluateItem(
      readyItem({ pullRequestId: 82, changedFiles: ["README.md"] }),
    );
    const blockedClaim = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    await store.claimAgentWork({
      repo: "elizaos/eliza",
      resourceKind: "path",
      resourceId: "README.md",
      ownerAgentId: "agent-one",
      paths: ["README.md"],
      expiresAt: "2027-07-06T00:00:00.000Z",
    });

    const readyQueue = await steward.listQueue();
    const claimed = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    assert.equal(blockedQueue.scheduled.length, 0);
    assert.equal(blockedQueue.items[0].workReservation.state, "blocked");
    assert.equal(blockedDecision.allowed, false);
    assert.ok(blockedDecision.blockers.includes("missing_work_reservation"));
    assert.equal(blockedClaim.claimed, false);
    assert.equal(blockedClaim.reason, "no_ready_items");

    assert.equal(readyQueue.scheduled.length, 1);
    assert.equal(readyQueue.items[0].workReservation.state, "covered");
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.item.id, "elizaos/eliza#82");
    assert.equal(claimed.item.workReservation.state, "covered");
  });

  it("blocks strict agent queue claims until a durable work item links the PR", async () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 83,
        ownerAgentId: "agent-one",
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const blockedQueue = await steward.listQueue();
    const blockedDecision = await steward.evaluateItem(
      readyItem({ pullRequestId: 83, ownerAgentId: "agent-one" }),
    );
    const blockedClaim = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    await store.upsertWorkItem({
      repo: "elizaos/eliza",
      pullRequestId: 83,
      title: "Track PR 83",
      ownerAgentId: "agent-one",
      state: "in_progress",
    });

    const readyQueue = await steward.listQueue();
    const claimed = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    assert.equal(blockedQueue.scheduled.length, 0);
    assert.equal(blockedQueue.items[0].workItemLink.state, "missing");
    assert.equal(blockedDecision.allowed, false);
    assert.ok(blockedDecision.blockers.includes("missing_work_item"));
    assert.equal(blockedClaim.claimed, false);
    assert.equal(blockedClaim.reason, "no_ready_items");

    assert.equal(readyQueue.scheduled.length, 1);
    assert.equal(readyQueue.items[0].workItemLink.state, "linked");
    assert.equal(
      readyQueue.items[0].workItemLink.workItemId,
      "work:elizaos/eliza:pr:83",
    );
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.item.id, "elizaos/eliza#83");
    assert.equal(claimed.item.workItemLink.state, "linked");
  });

  it("inherits strict work tracking policy for agent submission gates", async () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      logger: silentLogger,
    });

    const gate = await steward.getAgentSubmissionGate({
      ownerAgentId: "agent-one",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-one",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 48,
        changedFiles: ["README.md"],
        affectedPackages: ["docs"],
      },
    });

    assert.equal(gate.decision.allowed, false);
    assert.ok(gate.decision.blockers.includes("work_item"));
    assert.ok(gate.decision.blockers.includes("work_reservation"));
    assert.ok(
      gate.decision.requiredActions.includes("create_or_link_work_item"),
    );
    assert.ok(
      gate.decision.requiredActions.includes(
        "reserve_agent_work_before_submission",
      ),
    );
    assert.equal(
      gate.gates.find((item) => item.name === "work_item").evidence.required,
      true,
    );
    assert.equal(
      gate.gates.find((item) => item.name === "work_reservation").evidence
        .required,
      true,
    );
  });

  it("does not schedule repositories with disabled persisted queue policy", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertRepoPolicy({
      repo: "elizaos/eliza",
      queueMode: "disabled",
    });
    await store.upsertQueueItem(readyItem({ pullRequestId: 62 }));
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const decision = await steward.evaluateItem(
      readyItem({ pullRequestId: 62 }),
    );
    const queue = await steward.listQueue();
    const claimed = await steward.claimNextQueueItem({
      workerId: "worker-one",
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.includes("repo_queue_disabled"));
    assert.equal(queue.scheduled.length, 0);
    assert.equal(claimed.claimed, false);
    assert.equal(claimed.reason, "no_ready_items");
  });

  it("applies and clears audited queue policy overrides", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({ pullRequestId: 72, hasExecutionPlan: false }),
    );
    await store.upsertRun({
      id: "run:elizaos/eliza#72",
      queueItemId: "elizaos/eliza#72",
      repo: "elizaos/eliza",
      pullRequestId: 72,
      status: "running",
    });
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const applied = await steward.overrideQueueItem("elizaos/eliza#72", {
      approvedBy: "operator-one",
      reason: "small scoped fix approved in chat",
      blockers: ["missing_agent_plan"],
      now: "2026-07-06T00:00:00.000Z",
    });
    const eventsAfterApply = await store.listEvents();
    const runEventsAfterApply = await store.listRunEvents(
      "run:elizaos/eliza#72",
    );
    const cleared = await steward.clearQueueItemOverride("elizaos/eliza#72", {
      clearedBy: "operator-one",
      reason: "override window closed",
      now: "2026-07-06T00:05:00.000Z",
    });
    const runEventsAfterClear = await store.listRunEvents(
      "run:elizaos/eliza#72",
    );

    assert.equal(applied.decision.allowed, true);
    assert.equal(applied.item.policyOverride.active, true);
    assert.equal(applied.item.policyOverride.approvedBy, "operator-one");
    assert.equal(eventsAfterApply[0].type, "queue.PolicyOverrideApplied");
    assert.equal(eventsAfterApply[0].actorId, "operator-one");
    assert.equal(eventsAfterApply[0].payload.decision.allowed, true);
    assert.equal(runEventsAfterApply[0].type, "PolicyOverrideApplied");
    assert.equal(runEventsAfterApply[0].actorId, "operator-one");
    assert.equal(cleared.decision.allowed, false);
    assert.deepEqual(cleared.decision.blockers, ["missing_agent_plan"]);
    assert.equal(cleared.item.policyOverride.active, false);
    assert.equal(cleared.item.policyOverride.clearedBy, "operator-one");
    assert.equal(runEventsAfterClear.at(-1).type, "PolicyOverrideCleared");
  });

  it("does not treat scoped queue policy overrides as broad human approval", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 73,
        hasExecutionPlan: false,
        changedFiles: ["packages/cloud-api/auth/session.ts"],
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const applied = await steward.overrideQueueItem("elizaos/eliza#73", {
      approvedBy: "operator-one",
      reason: "missing plan accepted only",
      blockers: ["missing_agent_plan"],
      now: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(applied.item.hasHumanApproval, undefined);
    assert.equal(applied.decision.allowed, false);
    assert.deepEqual(applied.decision.blockers, ["sensitive_paths_need_human"]);
    assert.deepEqual(applied.decision.policyOverride.overriddenBlockers, [
      "missing_agent_plan",
    ]);
  });

  it("keeps stack dependency blockers in audited policy override decisions", async () => {
    const config = loadConfig();
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 85,
        sourceBranch: "agent/stack/root",
        targetBranch: "develop",
      }),
    );
    await store.upsertQueueItem(
      readyItem({
        pullRequestId: 86,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        hasExecutionPlan: false,
      }),
    );
    const steward = new MergeSteward({ config, store, logger: silentLogger });

    const applied = await steward.overrideQueueItem("elizaos/eliza#86", {
      approvedBy: "operator-one",
      reason: "plan reviewed manually, stack still must land in order",
      blockers: ["missing_agent_plan"],
      now: "2026-07-06T00:00:00.000Z",
    });
    const events = await store.listEvents();

    assert.equal(applied.decision.allowed, false);
    assert.deepEqual(applied.decision.blockers, ["stack_dependency_pending"]);
    assert.equal(applied.decision.stackDependency.state, "waiting_on_stack");
    assert.deepEqual(events[0].payload.decision.blockers, [
      "stack_dependency_pending",
    ]);
  });

  it("refreshes persisted items before live execution and blocks newly failing checks", async () => {
    const calls = [];
    const config = loadConfig({
      FORGEJO_ENRICHMENT_ENABLED: "true",
      FORGEJO_PROTECTED_BRANCHES: "develop",
      FORGEJO_REQUIRED_CHECKS: "smoke",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem(
      readyItem({ pullRequestId: 12, headSha: "head-sha-12" }),
    );
    const steward = new MergeSteward({
      config,
      store,
      enrichmentClient: enrichmentClient({ checkState: "failure" }),
      integrationClient: integrationClient(calls),
      logger: silentLogger,
    });

    const result = await steward.executeIntegration(
      [readyItem({ pullRequestId: 99 })],
      { confirmed: true },
    );
    const stored = await store.getQueueItem("elizaos/eliza#12");

    assert.equal(result.plan.planCount, 0);
    assert.equal(result.execution.reason, "no_ready_items");
    assert.equal(stored.checkResults.smoke, "failure");
    assert.deepEqual(calls, []);
  });

  it("preserves stored agent ownership when label webhooks only include deltas", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 12,
      headSha: "head-sha-12",
      authorKind: "agent",
      ownerAgentId: "agent-one",
      agentKnown: true,
      labels: ["queue:ready", "agent:agent-one"],
    });
    const steward = new MergeSteward({ config, store, logger: silentLogger });
    const rawBody = JSON.stringify(
      pullRequestPayload({
        labels: [],
        changes: {
          labels: {
            added: [{ name: "risk:low" }],
            removed: [{ name: "queue:ready" }],
          },
        },
      }),
    );

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, {
        "x-forgejo-event": "pull_request",
        "x-forgejo-event-type": "pull_request_label",
      }),
      rawBody,
    });

    assert.equal(result.item.ownerAgentId, "agent-one");
    assert.equal(result.item.agentKnown, true);
    assert.deepEqual(result.item.labels, ["agent:agent-one", "risk:low"]);
  });

  it("uses read-only Forgejo enrichment facts in the merge decision", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      FORGEJO_PROTECTED_BRANCHES: "develop",
      FORGEJO_REQUIRED_CHECKS: "smoke",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      enrichmentClient: enrichmentClient(),
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    assert.equal(result.enrichment.enabled, true);
    assert.equal(result.enrichment.skipped, false);
    assert.equal(result.item.targetProtected, true);
    assert.equal(result.item.reviewSatisfied, true);
    assert.equal(result.item.changedLines, 6);
    assert.deepEqual(result.item.changedFiles, ["README.md"]);
    assert.deepEqual(result.item.requiredChecks, ["smoke"]);
    assert.equal(result.item.checkResults.smoke, "success");
    assert.equal(result.decision.allowed, true);
  });

  it("keeps webhook delivery accepted when read-only enrichment fails", async () => {
    process.env.STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "STEWARD_TEST_SECRET",
      FORGEJO_ENRICHMENT_ENABLED: "true",
    });
    const steward = new MergeSteward({
      config,
      store: new InMemoryQueueStore(),
      enrichmentClient: {
        async getPullRequest() {
          throw new Error("Forgejo read unavailable");
        },
      },
      logger: silentLogger,
    });
    const rawBody = JSON.stringify(pullRequestPayload());

    const result = await steward.handleWebhookDelivery({
      headers: signedHeaders(rawBody, { "x-forgejo-event": "pull_request" }),
      rawBody,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.enrichment.skipped, true);
    assert.equal(result.enrichment.reason, "forgejo_enrichment_failed");
    assert.equal(result.item.id, "elizaos/eliza#12");
    assert.equal(result.decision.allowed, false);
  });
});

const WEBHOOK_SECRET = "local-steward-webhook-secret";

const silentLogger = Object.freeze({
  error() {},
  info() {},
});

const baseRepository = Object.freeze({
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
});

function pullRequestPayload({
  labels = [{ name: "queue:ready" }, { name: "agent:agent-one" }],
  changes,
  pullRequest = {},
} = {}) {
  return {
    action: "label_updated",
    number: 12,
    repository: baseRepository,
    pull_request: {
      id: 99,
      number: 12,
      title: "task-agent-12: queue-friendly change",
      body: "Fixes #12\n\n## Plan\nUpdate the queue policy.\n\n## Validation\nRun merge-steward tests.",
      state: "open",
      merged: false,
      mergeable: true,
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
        sha: "head-sha-12",
        repo: baseRepository,
      },
      labels,
      ...pullRequest,
    },
    changes,
    sender: {
      id: 21,
      login: "agent-one",
      username: "agent-one",
    },
  };
}

function readyItem(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 12,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    headSha: "head-sha-12",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    agentKnown: true,
    hasIssueLink: true,
    hasExecutionPlan: true,
    hasValidationPlan: true,
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedFiles: ["README.md"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  };
}

function enrichmentClient({ checkState = "success" } = {}) {
  return {
    async getPullRequest() {
      return {
        number: 12,
        title: "task-agent-12: queue-friendly change",
        body: "Fixes #12\n\n## Plan\nUpdate the queue policy.\n\n## Validation\nRun merge-steward tests.",
        user: { login: "agent-one" },
        base: { ref: "develop", sha: "base-sha" },
        head: { ref: "agent/change", sha: "head-sha-12" },
        labels: [{ name: "agent:agent-one" }, { name: "queue:ready" }],
      };
    },
    async listPullRequestFiles() {
      return [{ filename: "README.md", additions: 4, deletions: 2 }];
    },
    async listPullRequestReviews() {
      return [{ state: "APPROVED", user: { login: "maintainer" } }];
    },
    async listCommitStatuses() {
      return [{ context: "smoke", state: checkState }];
    },
    async getCombinedCommitStatus() {
      return { statuses: [{ context: "smoke", state: checkState }] };
    },
  };
}

function integrationClient(
  calls,
  { currentHeadSha = "head-sha-12", failAction } = {},
) {
  return {
    async ensureIntegrationBranch(input) {
      calls.push(["ensureIntegrationBranch", input]);
      failIntegrationAction("ensureIntegrationBranch", failAction);
      return { ok: true };
    },
    async mergePullRequestHeadIntoIntegration(input) {
      calls.push(["mergePullRequestHeadIntoIntegration", input]);
      failIntegrationAction("mergePullRequestHeadIntoIntegration", failAction);
      return { ok: true };
    },
    async waitForIntegrationChecks(input) {
      calls.push(["waitForIntegrationChecks", input]);
      failIntegrationAction("waitForIntegrationChecks", failAction);
      return { ok: true };
    },
    async getPullRequest(repo, number) {
      calls.push(["getPullRequest", { repo, number }]);
      failIntegrationAction("getPullRequest", failAction);
      return {
        number,
        state: "open",
        merged: false,
        base: { ref: "develop" },
        head: {
          sha:
            typeof currentHeadSha === "object"
              ? currentHeadSha[number]
              : currentHeadSha,
        },
      };
    },
    async mergeOriginalPullRequest(input) {
      calls.push(["mergeOriginalPullRequest", input]);
      failIntegrationAction("mergeOriginalPullRequest", failAction);
      return { ok: true };
    },
  };
}

function failIntegrationAction(action, failAction) {
  if (action === failAction) {
    throw new Error(`${action} failed`);
  }
}

function signedHeaders(rawBody, headers = {}) {
  return {
    ...headers,
    "x-forgejo-signature": createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex"),
  };
}
