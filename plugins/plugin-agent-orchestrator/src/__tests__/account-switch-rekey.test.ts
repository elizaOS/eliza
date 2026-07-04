/**
 * Proves the event bridge re-keys a task's durable session record when a
 * cli-transport follow-up prompt fails over to a different pooled account
 * (`account_switched`) — and that the consumers of that record then attribute
 * correctly: recordUsage bills the account actually serving, and a rate-limit
 * error cools off that account, not the spawn-time one. Deterministic; real
 * OrchestratorTaskService + memory-backed store, fake ACP event source.
 */

import type { CodingAgentSelectorBridge } from "@elizaos/core";
import { setCodingAgentSelectorBridge } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

function makeFakeAcp() {
  let handler: EventHandler | undefined;
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    getSession: vi.fn(async () => null),
    getChangedPaths: vi.fn(() => [] as string[]),
  };
  return {
    service,
    emit: (sessionId: string, event: string, data: unknown) =>
      handler?.(sessionId, event, data),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
): Record<string, unknown> {
  return {
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: vi.fn(async () => "{}"),
    reportError: vi.fn(),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

/** Bridge double that records which account usage + health marks land on. */
function makeRecordingBridge() {
  const usage: Array<{ providerId: string; accountId: string }> = [];
  const rateLimited: Array<{ providerId: string; accountId: string }> = [];
  const bridge: CodingAgentSelectorBridge = {
    describe: () => ({}),
    select: async () => null,
    async markRateLimited(providerId, accountId) {
      rateLimited.push({ providerId, accountId });
    },
    async markNeedsReauth() {},
    async recordUsage(providerId, accountId) {
      usage.push({ providerId, accountId });
    },
  };
  return { bridge, usage, rateLimited };
}

async function seedTaskWithSession(
  store: OrchestratorTaskStore,
): Promise<{ taskId: string; sessionId: string }> {
  const detail = await store.createTask({
    title: "t",
    goal: "do the thing",
    acceptanceCriteria: [],
  });
  const taskId = detail.task.id;
  const sessionId = "sess-rekey-1";
  const now = Date.now();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "claude",
    accountProviderId: "anthropic-subscription",
    accountId: "acct-a",
    accountLabel: "A",
    label: "Ada",
    originalTask: "do the thing",
    workdir: "/tmp/x",
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  await store.updateTask(taskId, { status: "active" });
  return { taskId, sessionId };
}

describe("account_switched re-keys usage + health attribution", () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  });
  afterEach(() => {
    if (savedFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedFlag;
    setCodingAgentSelectorBridge(null);
  });

  it("updates the durable session record, then bills + health-marks the NEW account", async () => {
    const { bridge, usage, rateLimited } = makeRecordingBridge();
    setCodingAgentSelectorBridge(bridge);
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { sessionId } = await seedTaskWithSession(store);
    const runtime = makeRuntime(fake.service);
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "account_switched", {
      providerId: "anthropic-subscription",
      accountId: "acct-b",
      label: "B",
    });
    await vi.waitFor(async () => {
      const found = await store.findSession(sessionId);
      expect(found?.session.accountId).toBe("acct-b");
    });
    const found = await store.findSession(sessionId);
    expect(found?.session.accountProviderId).toBe("anthropic-subscription");
    expect(found?.session.accountLabel).toBe("B");

    // Usage after the switch lands on B's ledger, not spawn-time A's.
    fake.emit(sessionId, "usage_update", {
      inputTokens: 100,
      outputTokens: 50,
      state: "measured",
    });
    await vi.waitFor(() => {
      expect(usage).toHaveLength(1);
    });
    expect(usage[0]).toEqual({
      providerId: "anthropic-subscription",
      accountId: "acct-b",
    });

    // A rate-limit failure after the switch cools off B — the account that is
    // actually limited — instead of sidelining healthy A.
    fake.emit(sessionId, "error", { message: "429 rate limit exceeded" });
    await vi.waitFor(() => {
      expect(rateLimited).toHaveLength(1);
    });
    expect(rateLimited[0]).toEqual({
      providerId: "anthropic-subscription",
      accountId: "acct-b",
    });

    await service.stop();
  });

  it("ignores a malformed account_switched payload (record stays keyed as-is)", async () => {
    const { bridge } = makeRecordingBridge();
    setCodingAgentSelectorBridge(bridge);
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { sessionId } = await seedTaskWithSession(store);
    const runtime = makeRuntime(fake.service);
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "account_switched", { label: "no ids" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const found = await store.findSession(sessionId);
    expect(found?.session.accountId).toBe("acct-a");
    expect(found?.session.accountProviderId).toBe("anthropic-subscription");

    await service.stop();
  });
});
