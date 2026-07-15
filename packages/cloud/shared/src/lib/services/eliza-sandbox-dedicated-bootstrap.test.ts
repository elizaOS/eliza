/**
 * Covers dedicated-agent bootstrap routing through shared and container
 * runtimes using deterministic repository and transport fixtures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import * as realAiBillingNs from "./ai-billing";
import * as realAiBillingRecordsNs from "./ai-billing-records";
import * as realRunSharedAgentTurnNs from "./shared-runtime/run-shared-agent-turn";

/**
 * A freshly-created DEDICATED agent is served by the in-Worker shared runtime
 * while its container provisions, so the user can chat immediately (the
 * first-run timeout fix). This proves `bridge()` routes a bootstrapping
 * dedicated agent to the shared turn — and that it does NOT hijack an
 * established (non-bootstrap) dedicated agent.
 */

// See eliza-sandbox-shared-billing.test.ts for why these process-global mocks
// are installed in beforeAll and restored in afterAll.
const realRunSharedAgentTurn = { ...realRunSharedAgentTurnNs };
const realAiBilling = { ...realAiBillingNs };
const realAiBillingRecords = { ...realAiBillingRecordsNs };
const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

const reconcileReservation = mock(async (actualCost: number) => ({
  reservedAmount: 0.002,
  actualCost,
  reservationTransactionId: "reservation-1",
  settlementTransactionIds: ["settlement-1"],
  adjustmentType: "refund" as const,
}));
const reserveCredits = mock(async () => ({
  reservedAmount: 0.002,
  reservationTransactionId: "reservation-1",
  reconcile: reconcileReservation,
}));
const billUsage = mock(async () => ({
  inputCost: 0.0001,
  outputCost: 0.0002,
  totalCost: 0.0003,
  baseInputCost: 0,
  baseOutputCost: 0,
  baseTotalCost: 0.00025,
  platformMarkup: 0.00005,
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
  markupApplied: true,
}));
const recordUsageAnalytics = mock(async () => ({ id: "usage-1" }));
const estimateInputTokens = mock(() => 42);

class MockInsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

const aiBillingRecord = mock(async () => ({ id: "ai-billing-1" }));

const runSharedAgentTurn = mock(async () => ({
  reply: "bootstrap reply",
  history: [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "bootstrap reply" },
  ],
  model: "gpt-oss-120b",
  degraded: false,
  usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
}));
const resolveSharedAgentTurnModel = mock(() => "gpt-oss-120b");

beforeAll(() => {
  mock.module("./ai-billing", () => ({
    reserveCredits,
    billUsage,
    recordUsageAnalytics,
    estimateInputTokens,
    InsufficientCreditsError: MockInsufficientCreditsError,
  }));
  mock.module("./ai-billing-records", () => ({
    aiBillingRecordsService: { record: aiBillingRecord },
  }));
  mock.module("./shared-runtime/run-shared-agent-turn", () => ({
    runSharedAgentTurn,
    resolveSharedAgentTurnModel,
  }));
});

afterAll(() => {
  mock.module("./shared-runtime/run-shared-agent-turn", () => realRunSharedAgentTurn);
  mock.module("./ai-billing", () => realAiBilling);
  mock.module("./ai-billing-records", () => realAiBillingRecords);
});

function dedicatedSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
  const now = new Date("2026-06-04T12:00:00.000Z");
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: null,
    status: "provisioning",
    execution_tier: "dedicated-always",
    bridge_url: null,
    health_url: null,
    agent_name: "boot-nancy",
    agent_config: { system: "You are boot-nancy." },
    database_uri: null,
    database_status: "none",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: {},
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  } as AgentSandbox;
}

function enterWorkerRuntime(): void {
  Object.defineProperty(globalThis, "WebSocketPair", {
    value: class WebSocketPair {},
    configurable: true,
  });
}

function restoreWorkerRuntime(): void {
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWorkerRuntime();
  reconcileReservation.mockClear();
  reserveCredits.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  estimateInputTokens.mockClear();
  aiBillingRecord.mockClear();
  runSharedAgentTurn.mockClear();
  resolveSharedAgentTurnModel.mockClear();
});

describe("ElizaSandboxService bridge — dedicated bootstrap window", () => {
  test("serves message.send via the shared runtime while the container provisions", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = dedicatedSandbox();
    // Not running yet → findRunningSandbox misses; bridge re-resolves by id+org.
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      sandbox,
    );
    const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
    const historyUpsertSpy = spyOn(sharedRuntimeHistoryRepository, "upsert").mockResolvedValue(
      undefined,
    );

    try {
      const response = await runWithCloudBindings({ CEREBRAS_API_KEY: "test-key" }, () =>
        new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
          jsonrpc: "2.0",
          id: "boot-turn",
          method: "message.send",
          params: { text: "hello" },
        }),
      );

      expect(response.error).toBeUndefined();
      expect((response.result as { text?: string }).text).toBe("bootstrap reply");
      expect(runSharedAgentTurn).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).toHaveBeenCalledWith(sandbox.id, sandbox.organization_id);
    } finally {
      findRunningSpy.mockRestore();
      findByIdSpy.mockRestore();
      historyGetSpy.mockRestore();
      historyUpsertSpy.mockRestore();
    }
  });

  test("status.get reports ready during the bootstrap window", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = dedicatedSandbox();
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      sandbox,
    );

    try {
      const response = await runWithCloudBindings({}, () =>
        new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
          jsonrpc: "2.0",
          id: "boot-status",
          method: "status.get",
          params: {},
        }),
      );
      expect(response.error).toBeUndefined();
      expect((response.result as { ready?: boolean }).ready).toBe(true);
    } finally {
      findRunningSpy.mockRestore();
      findByIdSpy.mockRestore();
    }
  });

  test("a freshly-minted tier-upgrade migration target (pending + marker) gets the bootstrap window too (#15943)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    enterWorkerRuntime();
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;
    // Exactly the row the single-flight mint commits: dedicated-always, born
    // `pending` with its provision job, carrying the server-side reattach
    // marker and its own minted platform env. Users keep chatting against the
    // target during the handoff poll — the marker must not disqualify it from
    // the shared-runtime bootstrap window while the container provisions.
    const sandbox = dedicatedSandbox({
      status: "pending",
      agent_config: {
        system: "You are boot-nancy.",
        __agentUpgradedFrom: "cccccccc-1111-4111-8111-111111111111",
      },
      environment_vars: {
        ELIZA_API_TOKEN: "agent_upgrade_token",
        ELIZA_CLOUD_AGENT_ID: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      },
    });
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      sandbox,
    );
    const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
    const historyUpsertSpy = spyOn(sharedRuntimeHistoryRepository, "upsert").mockResolvedValue(
      undefined,
    );

    try {
      const response = await runWithCloudBindings(
        {
          CEREBRAS_API_KEY: "test-key",
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "upgrade-boot-turn",
            method: "message.send",
            params: { text: "hello" },
          }),
      );
      expect(response.error).toBeUndefined();
      expect((response.result as { text?: string }).text).toBe("bootstrap reply");
      expect(runSharedAgentTurn).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      findRunningSpy.mockRestore();
      findByIdSpy.mockRestore();
      historyGetSpy.mockRestore();
      historyUpsertSpy.mockRestore();
    }
  });

  test("does NOT hijack an established dedicated agent that is merely stopped", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = dedicatedSandbox({
      status: "stopped",
      bridge_url: "https://boot-nancy.internal",
    });
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      sandbox,
    );

    try {
      const response = await runWithCloudBindings({}, () =>
        new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
          jsonrpc: "2.0",
          id: "stopped-turn",
          method: "message.send",
          params: { text: "hello" },
        }),
      );
      expect(response.result).toBeUndefined();
      expect(response.error?.message).toBe("Sandbox is not running");
      expect(runSharedAgentTurn).not.toHaveBeenCalled();
    } finally {
      findRunningSpy.mockRestore();
      findByIdSpy.mockRestore();
    }
  });
});
