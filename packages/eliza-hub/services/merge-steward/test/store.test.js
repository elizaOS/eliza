import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  agentClaimId,
  approvalId,
  attemptId,
  humanRequestId,
  InMemoryQueueStore,
  JsonFileQueueStore,
  normalizeWorkCycle,
  normalizeWorkItem,
  normalizeWorkModule,
  normalizeWorkView,
  queueItemId,
  registeredAgentId,
  repoPolicyId,
  runId,
  runNodeId,
  workCycleId,
  workerLeaseId,
  workItemId,
  workModuleId,
  workViewId,
} from "../src/store.js";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

describe("queue stores", () => {
  it("upserts queue items by repo and pull request id", async () => {
    const store = new InMemoryQueueStore();

    const first = await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 12,
      headSha: "a",
      labels: ["queue:ready"],
    });
    const second = await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 12,
      headSha: "b",
      labels: ["queue:ready", "agent:codex"],
    });

    assert.equal(first.id, "elizaos/eliza#12");
    assert.equal(second.id, "elizaos/eliza#12");
    assert.equal(second.createdAt, first.createdAt);
    assert.equal((await store.listQueueItems()).length, 1);
    assert.equal(
      (await store.findQueueItemByHeadSha("b")).id,
      "elizaos/eliza#12",
    );
  });

  it("persists queue items and received events to a JSON file", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      await writer.upsertQueueItem({
        repo: "elizaos/eliza",
        pullRequestId: 14,
        headSha: "head-sha",
        labels: ["queue:ready"],
      });
      await writer.appendEvent({
        type: "pull_request.opened",
        repo: "elizaos/eliza",
      });

      const reader = new JsonFileQueueStore(filePath);
      const items = await reader.listQueueItems();
      const events = await reader.listEvents();

      assert.equal(items.length, 1);
      assert.equal(items[0].id, "elizaos/eliza#14");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "pull_request.opened");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores durable work items and persists transitions", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-work-items-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const created = await writer.upsertWorkItem(
        {
          repo: "elizaos/eliza",
          taskId: "docs-agent-intake",
          title: "Document agent intake",
          ownerAgentId: "agent-docs",
          paths: ["docs/steward-runtime-model.md"],
          packages: ["docs"],
          labels: ["docs"],
        },
        {
          actorId: "agent-docs",
          now: "2026-07-07T00:00:00.000Z",
        },
      );
      const transitioned = await writer.transitionWorkItem(created.id, {
        state: "in_progress",
        transitionedBy: "agent-docs",
        reason: "claimed by docs agent",
        now: "2026-07-07T00:05:00.000Z",
      });

      const reader = new JsonFileQueueStore(filePath);
      const workItems = await reader.listWorkItems({
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
      });

      assert.equal(created.id, "work:elizaos/eliza:task:docs-agent-intake");
      assert.equal(transitioned.state, "in_progress");
      assert.equal(workItems.length, 1);
      assert.equal(workItems[0].state, "in_progress");
      assert.equal(workItems[0].updatedBy, "agent-docs");
      assert.equal(workItems[0].metadata.transitions[0].from, "ready");
      assert.equal(workItems[0].metadata.transitions[0].to, "in_progress");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores durable work cycles and modules with linked work items", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-work-scopes-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const cycle = await writer.upsertWorkCycle(
        {
          repo: "elizaos/eliza",
          title: "July agent hardening",
          state: "active",
          ownerAgentId: "agent-lead",
        },
        {
          actorId: "agent-lead",
          now: "2026-07-07T00:00:00.000Z",
        },
      );
      const module = await writer.upsertWorkModule(
        {
          repo: "elizaos/eliza",
          title: "Runtime",
          ownerAgentId: "agent-runtime",
          paths: ["packages/core"],
          packages: ["core"],
        },
        {
          actorId: "agent-runtime",
          now: "2026-07-07T00:01:00.000Z",
        },
      );
      await writer.upsertWorkItem(
        {
          repo: "elizaos/eliza",
          taskId: "runtime-followup",
          title: "Runtime followup",
          cycleId: cycle.id,
          moduleId: module.id,
          ownerAgentId: "agent-runtime",
        },
        {
          actorId: "agent-runtime",
          now: "2026-07-07T00:02:00.000Z",
        },
      );

      const reader = new JsonFileQueueStore(filePath);
      const cycles = await reader.listWorkCycles({
        repo: "elizaos/eliza",
        state: "active",
      });
      const modules = await reader.listWorkModules({
        repo: "elizaos/eliza",
        ownerAgentId: "agent-runtime",
      });
      const [workItem] = await reader.listWorkItems({ repo: "elizaos/eliza" });

      assert.equal(cycle.id, "cycle:elizaos/eliza:july-agent-hardening");
      assert.equal(module.id, "module:elizaos/eliza:runtime");
      assert.equal(cycles.length, 1);
      assert.equal(modules.length, 1);
      assert.equal(workItem.cycleId, cycle.id);
      assert.equal(workItem.moduleId, module.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores durable work saved views for dashboards", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-work-views-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const view = await writer.upsertWorkView(
        {
          repo: "elizaos/eliza",
          title: "Blocked docs work",
          kind: "kanban",
          ownerAgentId: "agent-docs",
          filters: {
            state: ["blocked"],
            packages: ["docs"],
          },
          columns: ["blocked", "ready"],
        },
        {
          actorId: "agent-docs",
          now: "2026-07-07T00:00:00.000Z",
        },
      );

      const reader = new JsonFileQueueStore(filePath);
      const views = await reader.listWorkViews({
        repo: "elizaos/eliza",
        kind: "kanban",
      });

      assert.equal(view.id, "view:elizaos/eliza:blocked-docs-work");
      assert.equal(views.length, 1);
      assert.deepEqual(views[0].filters.state, ["blocked"]);
      assert.deepEqual(views[0].columns, ["blocked", "ready"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores durable work pages for agent plans and runbooks", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-work-pages-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const page = await writer.upsertWorkPage(
        {
          repo: "elizaos/eliza",
          kind: "agent_plan",
          title: "Docs intake plan",
          workItemId: "work:elizaos/eliza:task:docs-agent-intake",
          ownerAgentId: "agent-docs",
          body: "## Plan\n\n- Update the steward docs.",
          tags: ["docs", "plan"],
        },
        {
          actorId: "agent-docs",
          now: "2026-07-07T00:00:00.000Z",
        },
      );
      const archived = await writer.transitionWorkPage(page.id, {
        state: "archived",
        transitionedBy: "agent-docs",
        reason: "plan superseded",
        now: "2026-07-07T00:05:00.000Z",
      });

      const reader = new JsonFileQueueStore(filePath);
      const pages = await reader.listWorkPages({
        repo: "elizaos/eliza",
        workItemId: "work:elizaos/eliza:task:docs-agent-intake",
      });

      assert.equal(
        page.id,
        "page:elizaos/eliza:work:work-elizaos-eliza-task-docs-agent-intake:agent_plan",
      );
      assert.equal(archived.state, "archived");
      assert.equal(pages.length, 1);
      assert.equal(pages[0].kind, "agent_plan");
      assert.equal(pages[0].format, "markdown");
      assert.equal(pages[0].metadata.transitions[0].reason, "plan superseded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("claims one running item per repository target lane", async () => {
    const store = new InMemoryQueueStore();
    const now = "2026-07-06T00:00:00.000Z";

    const first = await store.claimNextQueueItem(
      [
        claimableItem({ pullRequestId: 11, priority: 3 }),
        claimableItem({ pullRequestId: 12, priority: 2 }),
      ],
      { workerId: "worker-a", now },
    );
    const second = await store.claimNextQueueItem(
      [claimableItem({ pullRequestId: 12 })],
      {
        workerId: "worker-b",
        now,
      },
    );
    const differentTarget = await store.claimNextQueueItem(
      [claimableItem({ pullRequestId: 13, targetBranch: "main" })],
      { workerId: "worker-c", now },
    );

    assert.equal(first.claimed, true);
    assert.equal(first.item.id, "elizaos/eliza#11");
    assert.equal(first.item.queueState, "running");
    assert.equal(first.item.claimedBy, "worker-a");
    assert.equal(first.item.claimedAt, now);
    assert.equal(first.item.attemptCount, 1);
    assert.equal(second.claimed, false);
    assert.equal(second.reason, "repo_or_target_busy");
    assert.equal(differentTarget.claimed, true);
    assert.equal(differentTarget.item.id, "elizaos/eliza#13");
  });

  it("treats building integration queue items as active lane work", async () => {
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem({
      ...claimableItem({ pullRequestId: 20 }),
      queueState: "building_integration",
      claimedBy: "worker-one",
      claimedAt: "2026-07-06T00:00:00.000Z",
    });

    const result = await store.claimNextQueueItem(
      [claimableItem({ pullRequestId: 21 })],
      {
        workerId: "worker-two",
      },
    );

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "repo_or_target_busy");
  });

  it("claims a same-lane queue item batch atomically", async () => {
    const store = new InMemoryQueueStore();
    const now = "2026-07-06T00:00:00.000Z";

    const claimed = await store.claimQueueItems(
      [
        claimableItem({ pullRequestId: 21 }),
        claimableItem({ pullRequestId: 22 }),
      ],
      { workerId: "worker-train", now },
    );
    const blocked = await store.claimQueueItems(
      [claimableItem({ pullRequestId: 23 })],
      {
        workerId: "worker-two",
        now,
      },
    );

    assert.equal(claimed.claimed, true);
    assert.deepEqual(
      claimed.items.map((item) => item.id),
      ["elizaos/eliza#21", "elizaos/eliza#22"],
    );
    assert.deepEqual(
      claimed.items.map((item) => item.queueState),
      ["running", "running"],
    );
    assert.deepEqual(
      claimed.items.map((item) => item.claimedBy),
      ["worker-train", "worker-train"],
    );
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.reason, "repo_or_target_busy");
  });

  it("does not partially claim queue item batches across lanes", async () => {
    const store = new InMemoryQueueStore();
    const result = await store.claimQueueItems([
      claimableItem({ pullRequestId: 31, targetBranch: "develop" }),
      claimableItem({ pullRequestId: 32, targetBranch: "main" }),
    ]);

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "different_queue_lane");
    assert.deepEqual(await store.listQueueItems(), []);
  });

  it("does not reclaim terminal or future queue items", async () => {
    const store = new InMemoryQueueStore();

    await store.upsertQueueItem({
      ...claimableItem({ pullRequestId: 15 }),
      queueState: "merged",
    });

    const terminal = await store.claimNextQueueItem([
      claimableItem({ pullRequestId: 15 }),
    ]);
    const future = await store.claimNextQueueItem(
      [
        claimableItem({
          pullRequestId: 16,
          availableAt: "2026-07-07T00:00:00.000Z",
        }),
      ],
      {
        now: "2026-07-06T00:00:00.000Z",
      },
    );

    assert.equal(terminal.claimed, false);
    assert.equal(terminal.reason, "no_claimable_items");
    assert.equal(future.claimed, false);
    assert.equal(future.reason, "no_available_items");
  });

  it("persists queue claim completion and failure lifecycle state", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const claimed = await writer.claimNextQueueItem(
        [claimableItem({ pullRequestId: 17 })],
        {
          workerId: "worker-json",
          now: "2026-07-06T00:00:00.000Z",
        },
      );
      await writer.finishQueueItem(claimed.item.id, {
        state: "merged",
        now: "2026-07-06T00:01:00.000Z",
      });

      const failed = await writer.claimNextQueueItem(
        [claimableItem({ repo: "elizaos/runtime", pullRequestId: 18 })],
        { now: "2026-07-06T00:02:00.000Z" },
      );
      await writer.failQueueItem(failed.item.id, {
        error: "checks failed",
        now: "2026-07-06T00:03:00.000Z",
      });

      const reader = new JsonFileQueueStore(filePath);
      const mergedItem = await reader.getQueueItem("elizaos/eliza#17");
      const failedItem = await reader.getQueueItem("elizaos/runtime#18");

      assert.equal(mergedItem.queueState, "merged");
      assert.equal(mergedItem.finishedAt, "2026-07-06T00:01:00.000Z");
      assert.equal(failedItem.queueState, "failed");
      assert.equal(failedItem.lastError, "checks failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fences queue completion by active run ownership when requested", async () => {
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem({
      ...claimableItem({ pullRequestId: 19 }),
      queueState: "building_integration",
      claimedBy: "worker-one",
      activeRunId: "run-one",
    });

    const blocked = await store.finishQueueItem("elizaos/eliza#19", {
      state: "merged",
      activeRunId: "run-two",
      claimedBy: "worker-one",
      queueState: "building_integration",
    });
    const finished = await store.finishQueueItem("elizaos/eliza#19", {
      state: "merged",
      activeRunId: "run-one",
      claimedBy: "worker-one",
      queueState: "building_integration",
    });

    assert.equal(blocked, null);
    assert.equal(finished.queueState, "merged");
  });

  it("claims, renews, releases, and reclaims worker leases", async () => {
    const store = new InMemoryQueueStore();
    const first = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-a" },
      { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
    );
    const blocked = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-b" },
      { now: "2026-07-06T00:00:10.000Z", ttlMs: 30000 },
    );
    const renewed = await store.heartbeatWorkerLease("merge-queue", {
      ownerId: "worker-a",
      now: "2026-07-06T00:00:15.000Z",
      ttlMs: 30000,
    });
    const released = await store.releaseWorkerLease("merge-queue", {
      ownerId: "worker-a",
      reason: "shutdown",
      now: "2026-07-06T00:00:20.000Z",
    });
    const reclaimed = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-b" },
      { now: "2026-07-06T00:00:21.000Z", ttlMs: 30000 },
    );

    assert.equal(first.claimed, true);
    assert.equal(first.lease.ownerId, "worker-a");
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.reason, "lease_held");
    assert.equal(blocked.lease.ownerId, "worker-a");
    assert.equal(renewed.expiresAt, "2026-07-06T00:00:45.000Z");
    assert.equal(released.status, "released");
    assert.equal(released.releaseReason, "shutdown");
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.lease.ownerId, "worker-b");
    assert.equal(workerLeaseId({ leaseId: "merge-queue" }), "merge-queue");
    assert.equal(workerLeaseId("merge-queue"), "merge-queue");
  });

  it("lets an expired worker lease be claimed by another owner", async () => {
    const store = new InMemoryQueueStore();
    await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-a" },
      { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
    );

    const reclaimed = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-b" },
      { now: "2026-07-06T00:00:31.000Z", ttlMs: 30000 },
    );

    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.lease.ownerId, "worker-b");
    assert.equal(reclaimed.lease.acquiredAt, "2026-07-06T00:00:31.000Z");
  });

  it("does not heartbeat an expired worker lease", async () => {
    const store = new InMemoryQueueStore();
    await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-a" },
      { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
    );

    const heartbeat = await store.heartbeatWorkerLease("merge-queue", {
      ownerId: "worker-a",
      now: "2026-07-06T00:00:31.000Z",
      ttlMs: 30000,
    });
    const lease = await store.getWorkerLease("merge-queue");

    assert.equal(heartbeat, null);
    assert.equal(lease.ownerId, "worker-a");
    assert.equal(lease.renewedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(lease.expiresAt, "2026-07-06T00:00:30.000Z");
  });

  it("persists worker leases to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      await writer.claimWorkerLease(
        { id: "merge-queue", ownerId: "worker-json" },
        { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
      );

      const reader = new JsonFileQueueStore(filePath);
      const lease = await reader.getWorkerLease("merge-queue");

      assert.equal(lease.ownerId, "worker-json");
      assert.equal(lease.status, "active");
      assert.equal(lease.expiresAt, "2026-07-06T00:00:30.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds persisted webhook events by delivery id", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      await writer.appendEvent({
        type: "pull_request.opened",
        repo: "elizaos/eliza",
        deliveryId: "delivery-pr-14",
      });

      const reader = new JsonFileQueueStore(filePath);
      const event = await reader.findEventByDeliveryId("delivery-pr-14");

      assert.equal(event.deliveryId, "delivery-pr-14");
      assert.equal(
        await reader.findEventByDeliveryId("missing-delivery"),
        null,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores and decides human approvals", async () => {
    const store = new InMemoryQueueStore();

    const requested = await store.upsertApproval({
      queueItemId: "elizaos/eliza#19",
      request: { reason: "sensitive paths" },
      allowedActors: ["maintainer-one"],
    });
    const approved = await store.decideApproval(requested.id, {
      approved: true,
      decidedBy: "maintainer-one",
      note: "approved for staging",
      now: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(requested.id, "elizaos/eliza#19:human_approval:0");
    assert.equal(requested.status, "requested");
    assert.equal(
      (await store.listApprovals({ status: "requested" })).length,
      0,
    );
    assert.equal((await store.listApprovals({ status: "approved" })).length, 1);
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, "maintainer-one");
    assert.equal(approved.decision.note, "approved for staging");
  });

  it("persists approvals to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const requested = await writer.upsertApproval({
        queueItemId: "elizaos/eliza#20",
        nodeId: "deploy_approval",
      });
      await writer.decideApproval(requested.id, {
        approved: false,
        decidedBy: "maintainer-one",
        note: "needs safer rollout",
      });

      const reader = new JsonFileQueueStore(filePath);
      const approval = await reader.getApproval(
        "elizaos/eliza#20:deploy_approval:0",
      );

      assert.equal(approval.status, "denied");
      assert.equal(approval.decidedBy, "maintainer-one");
      assert.equal(approval.decision.note, "needs safer rollout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores human requests and external signals", async () => {
    const store = new InMemoryQueueStore();
    const request = await store.upsertHumanRequest({
      runId: "run-one",
      nodeId: "security_review",
      kind: "confirm",
      prompt: "Approve sensitive path change?",
    });
    const answered = await store.respondHumanRequest(request.id, {
      response: { approved: true },
      respondedBy: "operator-one",
    });
    const signal = await store.appendSignal({
      runId: "run-one",
      correlationKey: "checks:abc123",
      type: "checks.passed",
    });
    const consumed = await store.consumeSignal(signal.id, {
      consumerId: "merge-steward",
    });

    assert.equal(request.id, "human:run-one:security_review:0");
    assert.equal(answered.status, "answered");
    assert.equal(answered.response.approved, true);
    assert.equal(
      (await store.listHumanRequests({ runId: "run-one" })).length,
      1,
    );
    assert.equal(signal.status, "received");
    assert.equal(consumed.status, "consumed");
    assert.equal(
      (await store.listSignals({ correlationKey: "checks:abc123" })).length,
      1,
    );
  });

  it("persists human requests and signals to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const request = await writer.upsertHumanRequest({
        runId: "run-two",
        nodeId: "plan_review",
        kind: "select",
        options: ["merge", "hold"],
      });
      const signal = await writer.appendSignal({
        correlationKey: "forgejo:delivery:one",
        type: "pull_request.synchronized",
      });
      await writer.respondHumanRequest(request.id, {
        response: "merge",
        respondedBy: "operator-one",
      });
      await writer.consumeSignal(signal.id, { consumerId: "merge-steward" });

      const reader = new JsonFileQueueStore(filePath);
      const persistedRequest = await reader.getHumanRequest(request.id);
      const persistedSignals = await reader.listSignals({ status: "consumed" });

      assert.equal(persistedRequest.response, "merge");
      assert.equal(persistedSignals[0].type, "pull_request.synchronized");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("claims renews releases and reclaims agent work leases", async () => {
    const store = new InMemoryQueueStore();
    const first = await store.claimAgentWork(agentClaim(), {
      now: "2026-07-06T00:00:00.000Z",
      ttlMs: 60_000,
    });
    const conflict = await store.claimAgentWork(
      agentClaim({ ownerAgentId: "agent-two" }),
      {
        now: "2026-07-06T00:00:30.000Z",
        ttlMs: 60_000,
      },
    );
    const renewed = await store.renewAgentClaim(first.claim.id, {
      ownerAgentId: "agent-one",
      now: "2026-07-06T00:00:40.000Z",
      ttlMs: 120_000,
    });
    const ownerMismatch = await store.releaseAgentClaim(first.claim.id, {
      ownerAgentId: "agent-two",
      now: "2026-07-06T00:00:45.000Z",
    });
    const transferMismatch = await store.transferAgentClaim(first.claim.id, {
      fromOwnerAgentId: "agent-two",
      toOwnerAgentId: "agent-three",
      now: "2026-07-06T00:00:50.000Z",
    });
    const transferred = await store.transferAgentClaim(first.claim.id, {
      fromOwnerAgentId: "agent-one",
      toOwnerAgentId: "agent-two",
      reason: "handoff",
      now: "2026-07-06T00:00:55.000Z",
      ttlMs: 90_000,
    });
    const oldOwnerRelease = await store.releaseAgentClaim(first.claim.id, {
      ownerAgentId: "agent-one",
      now: "2026-07-06T00:00:58.000Z",
    });
    const released = await store.releaseAgentClaim(first.claim.id, {
      ownerAgentId: "agent-two",
      reason: "done",
      now: "2026-07-06T00:01:00.000Z",
    });
    const claimedAgain = await store.claimAgentWork(
      agentClaim({ ownerAgentId: "agent-two" }),
      {
        now: "2026-07-06T00:01:10.000Z",
        ttlMs: 60_000,
      },
    );
    const expiredTakeover = await store.claimAgentWork(
      agentClaim({ resourceId: "src/core.ts", ownerAgentId: "agent-three" }),
      {
        now: "2026-07-06T00:03:00.000Z",
        ttlMs: 60_000,
      },
    );

    assert.equal(first.claimed, true);
    assert.equal(first.claim.id, "claim:elizaos/eliza:path:src/core.ts");
    assert.equal(first.claim.expiresAt, "2026-07-06T00:01:00.000Z");
    assert.equal(conflict.claimed, false);
    assert.equal(conflict.reason, "already_claimed");
    assert.equal(renewed.expiresAt, "2026-07-06T00:02:40.000Z");
    assert.equal(ownerMismatch, null);
    assert.equal(transferMismatch, null);
    assert.equal(transferred.ownerAgentId, "agent-two");
    assert.equal(transferred.claimedAt, "2026-07-06T00:00:55.000Z");
    assert.equal(transferred.expiresAt, "2026-07-06T00:02:25.000Z");
    assert.equal(transferred.metadata.transferredFromAgentId, "agent-one");
    assert.equal(transferred.metadata.transferredToAgentId, "agent-two");
    assert.equal(transferred.metadata.transferReason, "handoff");
    assert.deepEqual(transferred.metadata.handoffs, [
      {
        fromAgentId: "agent-one",
        toAgentId: "agent-two",
        reason: "handoff",
        transferredAt: "2026-07-06T00:00:55.000Z",
      },
    ]);
    assert.equal(oldOwnerRelease, null);
    assert.equal(released.status, "released");
    assert.equal(released.releaseReason, "done");
    assert.equal(claimedAgain.claimed, true);
    assert.equal(claimedAgain.claim.ownerAgentId, "agent-two");
    assert.equal(expiredTakeover.claimed, true);
    assert.equal(expiredTakeover.claim.ownerAgentId, "agent-three");
    assert.equal(
      (await store.listAgentClaims({ ownerAgentId: "agent-three" })).length,
      1,
    );
  });

  it("deduplicates agent claim leases by repo resource even with custom ids", async () => {
    const store = new InMemoryQueueStore();
    const first = await store.claimAgentWork(
      agentClaim({ id: "custom-claim-one" }),
      {
        now: "2026-07-06T00:00:00.000Z",
      },
    );
    const conflict = await store.claimAgentWork(
      agentClaim({ id: "custom-claim-two", ownerAgentId: "agent-two" }),
      {
        now: "2026-07-06T00:01:00.000Z",
      },
    );
    const renewed = await store.claimAgentWork(
      agentClaim({ id: "custom-claim-two" }),
      {
        now: "2026-07-06T00:02:00.000Z",
      },
    );

    assert.equal(first.claimed, true);
    assert.equal(first.claim.id, "custom-claim-one");
    assert.equal(conflict.claimed, false);
    assert.equal(conflict.claim.id, "custom-claim-one");
    assert.equal(renewed.claimed, true);
    assert.equal(renewed.claim.id, "custom-claim-one");
    assert.equal(
      (
        await store.listAgentClaims({
          repo: "elizaos/eliza",
          resourceKind: "path",
        })
      ).length,
      1,
    );
  });

  it("rejects custom agent claim ids already assigned to another resource", async () => {
    const store = new InMemoryQueueStore();
    await store.claimAgentWork(
      agentClaim({ id: "custom-claim-one", resourceId: "src/core.ts" }),
    );
    const conflict = await store.claimAgentWork(
      agentClaim({ id: "custom-claim-one", resourceId: "src/other.ts" }),
    );

    assert.equal(conflict.claimed, false);
    assert.equal(conflict.reason, "claim_id_conflict");
    assert.equal(conflict.claim.resourceId, "src/core.ts");
  });

  it("persists agent claims to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const claimed = await writer.claimAgentWork(
        agentClaim({ resourceId: "packages/core" }),
        {
          now: "2026-07-06T00:00:00.000Z",
        },
      );
      await writer.renewAgentClaim(claimed.claim.id, {
        ownerAgentId: "agent-one",
        now: "2026-07-06T00:05:00.000Z",
      });

      const reader = new JsonFileQueueStore(filePath);
      const claim = await reader.getAgentClaim(
        "claim:elizaos/eliza:path:packages/core",
      );

      assert.equal(claim.status, "active");
      assert.equal(claim.ownerAgentId, "agent-one");
      assert.equal(claim.renewedAt, "2026-07-06T00:05:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores run nodes and events", async () => {
    const store = new InMemoryQueueStore();

    const run = await store.upsertRun({
      queueItemId: "elizaos/eliza#21",
      repo: "elizaos/eliza",
      pullRequestId: 21,
      status: "waiting_approval",
    });
    const node = await store.upsertRunNode({
      runId: run.id,
      nodeId: "human_approval",
      iteration: "2",
      status: "waiting_approval",
    });
    const event = await store.appendRunEvent({
      runId: run.id,
      type: "ApprovalRequested",
      payload: { reason: "sensitive path" },
    });
    const secondEvent = await store.appendRunEvent({
      runId: run.id,
      type: "NodeFinished",
    });

    assert.equal(run.id, "run:elizaos/eliza#21");
    assert.equal(node.id, "run:elizaos/eliza#21:human_approval:2");
    assert.equal(node.iteration, 2);
    assert.equal(event.id, "run:elizaos/eliza#21:event:1");
    assert.equal(event.seq, 1);
    assert.equal(secondEvent.id, "run:elizaos/eliza#21:event:2");
    assert.equal(secondEvent.seq, 2);
    assert.equal(
      (await store.listRuns({ status: "waiting_approval" })).length,
      1,
    );
    assert.equal((await store.listRunNodes(run.id)).length, 1);
    assert.equal((await store.listRunEvents(run.id)).length, 2);
    assert.equal(
      (await store.listRunEvents(run.id, { afterSeq: 1 }))[0].type,
      "NodeFinished",
    );
  });

  it("persists runs nodes and events to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const run = await writer.upsertRun({
        queueItemId: "elizaos/eliza#22",
        status: "running",
      });
      await writer.upsertRunNode({
        runId: run.id,
        nodeId: "policy",
        status: "succeeded",
      });
      await writer.appendRunEvent({
        runId: run.id,
        type: "NodeFinished",
      });

      const reader = new JsonFileQueueStore(filePath);
      const persistedRun = await reader.getRun("run:elizaos/eliza#22");

      assert.equal(persistedRun.status, "running");
      assert.equal(
        (await reader.listRunNodes(persistedRun.id))[0].nodeId,
        "policy",
      );
      assert.equal(
        (await reader.listRunEvents(persistedRun.id))[0].type,
        "NodeFinished",
      );
      assert.equal((await reader.listRunEvents(persistedRun.id))[0].seq, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores attempt lifecycle and stale recovery state", async () => {
    const store = new InMemoryQueueStore();

    const first = await store.startAttempt({
      runId: "run-one",
      nodeId: "policy",
      ownerId: "worker-a",
      heartbeatAt: "2026-07-06T00:00:00.000Z",
    });
    const ownerMismatch = await store.heartbeatAttempt(first.id, {
      ownerId: "worker-b",
      now: "2026-07-06T00:00:10.000Z",
    });
    const recovered = await store.claimStaleAttempt({
      workerId: "worker-b",
      now: "2026-07-06T00:01:00.000Z",
      staleAfterMs: 30_000,
    });
    const heartbeat = await store.heartbeatAttempt(first.id, {
      ownerId: "worker-b",
      now: "2026-07-06T00:01:05.000Z",
    });
    const finished = await store.finishAttempt(first.id, {
      output: { result: "ok" },
      now: "2026-07-06T00:01:10.000Z",
    });
    const second = await store.startAttempt({
      runId: "run-one",
      nodeId: "policy",
      ownerId: "worker-c",
    });
    const failed = await store.failAttempt(second.id, {
      error: "integration failed",
      retryAfterMs: 60_000,
      now: "2026-07-06T00:02:00.000Z",
    });

    assert.equal(first.id, "attempt:run-one:policy:1");
    assert.equal(ownerMismatch, null);
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.attempt.status, "recovering");
    assert.equal(recovered.attempt.ownerId, "worker-b");
    assert.equal(heartbeat.status, "running");
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.output.result, "ok");
    assert.equal(second.id, "attempt:run-one:policy:2");
    assert.equal(failed.status, "failed");
    assert.equal(failed.availableAt, "2026-07-06T00:03:00.000Z");
    assert.equal(
      (await store.listAttempts({ runId: "run-one", nodeId: "policy" })).length,
      2,
    );
  });

  it("persists attempts to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      const attempt = await writer.startAttempt({
        runId: "run-json",
        nodeId: "checks",
        ownerId: "worker-json",
      });
      await writer.cancelAttempt(attempt.id, {
        reason: "superseded",
        cancelledBy: "merge-steward",
      });

      const reader = new JsonFileQueueStore(filePath);
      const persisted = await reader.getAttempt("attempt:run-json:checks:1");

      assert.equal(persisted.status, "cancelled");
      assert.equal(persisted.cancelReason, "superseded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects queue items without a stable repository and pull request id", () => {
    assert.throws(
      () => queueItemId({ repo: "elizaos/eliza" }),
      /Queue item requires repo/,
    );
  });

  it("builds stable work item ids and validates work item state", () => {
    assert.equal(
      workItemId({ repo: "elizaos/eliza", taskId: "agent-intake" }),
      "work:elizaos/eliza:task:agent-intake",
    );
    assert.equal(
      workCycleId({ repo: "elizaos/eliza", title: "July agent hardening" }),
      "cycle:elizaos/eliza:july-agent-hardening",
    );
    assert.equal(
      workModuleId({ repo: "elizaos/eliza", title: "Runtime" }),
      "module:elizaos/eliza:runtime",
    );
    assert.equal(
      workViewId({ repo: "elizaos/eliza", title: "Blocked docs work" }),
      "view:elizaos/eliza:blocked-docs-work",
    );
    assert.equal(
      workItemId({ repo: "elizaos/eliza", pullRequestId: 15078 }),
      "work:elizaos/eliza:pr:15078",
    );
    assert.equal(
      normalizeWorkItem(
        {
          repo: "elizaos/eliza",
          title: "Coordinate docs work",
          state: "blocked",
        },
        null,
        { now: "2026-07-07T00:00:00.000Z" },
      ).id,
      "work:elizaos/eliza:title:coordinate-docs-work",
    );
    assert.throws(
      () =>
        normalizeWorkItem({
          repo: "elizaos/eliza",
          title: "Bad state",
          state: "thinking",
        }),
      /Work item state must be one of/,
    );
    assert.throws(
      () =>
        normalizeWorkCycle({
          repo: "elizaos/eliza",
          title: "Bad cycle",
          state: "waiting",
        }),
      /Work cycle state must be one of/,
    );
    assert.throws(
      () =>
        normalizeWorkModule({
          repo: "elizaos/eliza",
          title: "Bad module",
          state: "done",
        }),
      /Work module state must be one of/,
    );
    assert.throws(
      () =>
        normalizeWorkView({
          repo: "elizaos/eliza",
          title: "Bad view",
          kind: "mindmap",
        }),
      /Work view kind must be one of/,
    );
  });

  it("builds run-scoped approval ids and rejects approvals without a stable scope", () => {
    assert.equal(
      approvalId({ runId: "run-one", nodeId: "review" }),
      "run-one:review:0",
    );
    assert.throws(
      () => approvalId({ nodeId: "review" }),
      /Approval requires id, queueItemId, or runId/,
    );
  });

  it("rejects human requests without a stable id or run id", () => {
    assert.throws(
      () => humanRequestId({ nodeId: "review" }),
      /Human request requires id or runId/,
    );
  });

  it("rejects attempts without stable ids", () => {
    assert.throws(
      () => attemptId({ runId: "run-one", nodeId: "policy" }),
      /Attempt requires id/,
    );
    assert.throws(
      () => attemptId({ runId: "run-one", nodeId: "policy", attempt: 0 }),
      /Attempt number/,
    );
  });

  it("rejects run records and run nodes without stable ids", () => {
    assert.throws(() => runId({ status: "running" }), /Run requires id/);
    assert.throws(
      () => runNodeId({ runId: "run-one" }),
      /Run node requires runId and nodeId/,
    );
  });

  it("builds stable agent claim ids", () => {
    assert.equal(
      agentClaimId(agentClaim()),
      "claim:elizaos/eliza:path:src/core.ts",
    );
    assert.throws(
      () => agentClaimId({ repo: "elizaos/eliza" }),
      /Agent claim requires/,
    );
  });

  it("stores repository merge policies with durable defaults", async () => {
    const store = new InMemoryQueueStore();

    const created = await store.upsertRepoPolicy({
      repo: "elizaos/eliza",
      queueMode: "batched",
      protectedBranches: ["develop"],
      requiredChecks: ["test", "lint"],
      trustedActors: ["operator-one", "agent-one"],
      allowForks: true,
      policy: { maxBatchSize: 4 },
    });
    const updated = await store.upsertRepoPolicy({
      repo: "elizaos/eliza",
      requiredChecks: ["test", "lint", "typecheck"],
    });

    assert.equal(created.repo, "elizaos/eliza");
    assert.equal(updated.queueMode, "batched");
    assert.deepEqual(updated.protectedBranches, ["develop"]);
    assert.deepEqual(updated.requiredChecks, ["test", "lint", "typecheck"]);
    assert.deepEqual(updated.trustedActors, ["operator-one", "agent-one"]);
    assert.equal(updated.allowForks, true);
    assert.equal(updated.policy.maxBatchSize, 4);
    assert.equal((await store.listRepoPolicies()).length, 1);
    assert.equal(
      (await store.getRepoPolicy("elizaos/eliza")).queueMode,
      "batched",
    );
    await assert.rejects(
      () =>
        store.upsertRepoPolicy({ repo: "elizaos/eliza", queueMode: "chaos" }),
      /queueMode/,
    );
  });

  it("persists repository policies to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      await writer.upsertRepoPolicy({
        repo: "elizaos/eliza",
        queueMode: "serialized",
        requiredChecks: ["test"],
        policy: { mergeWindow: "always" },
      });

      const reader = new JsonFileQueueStore(filePath);
      const policy = await reader.getRepoPolicy("elizaos/eliza");

      assert.equal(policy.queueMode, "serialized");
      assert.deepEqual(policy.protectedBranches, ["main", "develop"]);
      assert.deepEqual(policy.requiredChecks, ["test"]);
      assert.equal(policy.policy.mergeWindow, "always");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores registered agent identities and filters active agents", async () => {
    const store = new InMemoryQueueStore();

    const created = await store.upsertRegisteredAgent(
      {
        id: "agent-docs",
        displayName: "Docs Agent",
        forgejoUsername: "eliza-agent-docs",
        elizaCloudSubject: "agent-subject-one",
        tenantId: "tenant-one",
        metadata: { model: "codex" },
      },
      {
        registeredBy: "operator-one",
        now: "2026-07-07T00:00:00.000Z",
      },
    );
    const disabled = await store.disableRegisteredAgent("agent-docs", {
      disabledBy: "operator-two",
      reason: "rotated",
      now: "2026-07-07T00:05:00.000Z",
    });

    assert.equal(created.id, "agent-docs");
    assert.equal(created.status, "active");
    assert.equal(created.registeredBy, "operator-one");
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.disabledBy, "operator-two");
    assert.equal(disabled.disableReason, "rotated");
    assert.deepEqual(
      await store.listRegisteredAgents({ status: "active" }),
      [],
    );
    assert.equal(
      (
        await store.listRegisteredAgents({
          status: "disabled",
          tenantId: "tenant-one",
        })
      ).length,
      1,
    );
  });

  it("persists registered agent identities to JSON storage", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-store-");
    const filePath = join(dir, "queue.json");

    try {
      const writer = new JsonFileQueueStore(filePath);
      await writer.upsertRegisteredAgent(
        {
          id: "agent-review",
          displayName: "Review Agent",
          source: "eliza-cloud",
        },
        {
          registeredBy: "admin-one",
          now: "2026-07-07T00:00:00.000Z",
        },
      );

      const reader = new JsonFileQueueStore(filePath);
      const agent = await reader.getRegisteredAgent("agent-review");

      assert.equal(agent.id, "agent-review");
      assert.equal(agent.displayName, "Review Agent");
      assert.equal(agent.source, "eliza-cloud");
      assert.equal(agent.registeredBy, "admin-one");
      assert.equal(
        (await reader.listRegisteredAgents({ status: "active" })).length,
        1,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds stable repository policy ids", () => {
    assert.equal(repoPolicyId({ repo: "elizaos/eliza" }), "elizaos/eliza");
    assert.equal(repoPolicyId("elizaos/eliza"), "elizaos/eliza");
    assert.throws(() => repoPolicyId({}), /Repository policy requires repo/);
  });

  it("builds stable registered agent ids", () => {
    assert.equal(registeredAgentId({ agentId: " agent-docs " }), "agent-docs");
    assert.equal(registeredAgentId("agent-review"), "agent-review");
    assert.throws(() => registeredAgentId({}), /Registered agent requires/);
  });
});

function claimableItem(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 11,
    targetBranch: "develop",
    headSha: "head-sha",
    labels: ["queue:ready"],
    ...overrides,
  };
}

function agentClaim(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-one",
    taskId: "task-one",
    paths: ["src/core.ts"],
    metadata: { reason: "editing" },
    ...overrides,
  };
}
