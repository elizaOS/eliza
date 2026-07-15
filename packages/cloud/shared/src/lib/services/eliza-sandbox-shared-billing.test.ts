/**
 * Covers shared-runtime reservation, settlement, and dedicated-routing billing
 * boundaries using deterministic repository and provider fixtures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import * as realAiBillingNs from "./ai-billing";
import * as realAiBillingRecordsNs from "./ai-billing-records";
import * as realRunSharedAgentTurnNs from "./shared-runtime/run-shared-agent-turn";

// Bun runs every cloud-shared test file in a single process, and `mock.module`
// overrides are process-global with no built-in per-file teardown. The mocks
// installed in `beforeAll` replace `./shared-runtime/run-shared-agent-turn`,
// `./ai-billing`, and `./ai-billing-records`; without an explicit restore they
// leak into later files that import the real modules (e.g.
// `agent-tier.test.ts` picking up the stub `runSharedAgentTurn` that always returns
// `degraded: false`), producing
// order-dependent failures. Snapshot the real exports into plain objects at
// module-evaluation time. Install only when this suite starts, then re-install
// the real exports in `afterAll`.
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
  baseInputCost: 0.00008333333333333333,
  baseOutputCost: 0.00016666666666666666,
  baseTotalCost: 0.00025,
  platformMarkup: 0.00005,
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
  markupApplied: true,
}));

const recordUsageAnalytics = mock(async () => ({
  id: "usage-1",
  organization_id: "22222222-2222-4222-8222-222222222222",
  user_id: "33333333-3333-4333-8333-333333333333",
  api_key_id: null,
  type: "chat",
  model: "gpt-oss-120b",
  provider: "cerebras",
  input_tokens: 11,
  output_tokens: 7,
  input_cost: "0.0001",
  output_cost: "0.0002",
  markup: "0.00005",
  request_id: "shared-runtime-request",
  is_successful: true,
  error_message: null,
  metadata: {},
  created_at: new Date("2026-06-04T12:00:00.000Z"),
}));

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
  reply: "metered reply",
  history: [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "metered reply" },
  ],
  model: "gpt-oss-120b",
  degraded: false,
  usage: {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
  },
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
    aiBillingRecordsService: {
      record: aiBillingRecord,
    },
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

function sharedSandbox(): AgentSandbox {
  const now = new Date("2026-06-04T12:00:00.000Z");
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: null,
    status: "running",
    execution_tier: "shared",
    bridge_url: null,
    health_url: null,
    agent_name: "shared-nancy",
    agent_config: { system: "You are shared-nancy." },
    database_uri: "postgres://agent-db.example",
    database_status: "ready",
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
  };
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

describe("ElizaSandboxService shared runtime billing", () => {
  test("running dedicated turns use the Worker router origin and bypass shared billing", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    enterWorkerRuntime();
    const sandbox = {
      ...sharedSandbox(),
      execution_tier: "dedicated-always",
      bridge_url: "https://legacy-bridge.example",
      health_url: "http://100.64.0.10:23816/api/health",
      node_id: "node-1",
      bridge_port: 18923,
      web_ui_port: 23816,
      headscale_ip: "100.64.0.10",
      sandbox_id: "sandbox-e06bb509",
      environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    } as AgentSandbox;
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: new Headers(init?.headers),
      });
      return Response.json({
        jsonrpc: "2.0",
        id: "dedicated-turn",
        result: { text: "dedicated reply" },
      });
    });

    try {
      const response = await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "dedicated-turn",
            method: "message.send",
            params: { text: "hello" },
          }),
      );

      expect(response.result).toMatchObject({
        text: "dedicated reply",
        transport: "native-jsonrpc",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://eliza-production-1.elizacloud.ai/bridge");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer agent-token");
      expect(requests[0]?.headers.get("x-forwarded-host")).toBe(`${sandbox.id}.elizacloud.ai`);
      expect(runSharedAgentTurn).not.toHaveBeenCalled();
      expect(reserveCredits).not.toHaveBeenCalled();
      expect(billUsage).not.toHaveBeenCalled();
    } finally {
      findRunningSandboxSpy.mockRestore();
    }
  });

  test("meters successful shared-runtime turns", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = sharedSandbox();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
    const historyUpsertSpy = spyOn(sharedRuntimeHistoryRepository, "upsert").mockResolvedValue(
      undefined,
    );

    try {
      const response = await runWithCloudBindings(
        {
          CEREBRAS_API_KEY: "test-key",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "shared-turn",
            method: "message.send",
            params: { text: "hello" },
          }),
      );

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "shared-turn",
        result: {
          text: "metered reply",
          agentName: "shared-nancy",
          channelId: expect.any(String),
          model: "gpt-oss-120b",
          degraded: false,
          runtime: "shared",
          transport: "shared-runtime",
        },
      });
      expect(reserveCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: sandbox.organization_id,
          userId: sandbox.user_id,
          model: "gpt-oss-120b",
        }),
        42,
        500,
      );
      expect(billUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: sandbox.organization_id,
          model: "gpt-oss-120b",
        }),
        { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      );
      expect(reconcileReservation).toHaveBeenCalledWith(0.0003);
      expect(recordUsageAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: sandbox.organization_id,
          model: "gpt-oss-120b",
        }),
        expect.objectContaining({ totalCost: 0.0003 }),
        expect.objectContaining({ type: "chat", content: "metered reply", prompt: "hello" }),
      );
      expect(aiBillingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^shared-runtime:/),
          reconciliation: expect.objectContaining({
            reservationTransactionId: "reservation-1",
          }),
        }),
      );
      expect(historyGetSpy).toHaveBeenCalled();
      expect(historyUpsertSpy).toHaveBeenCalled();
    } finally {
      findRunningSandboxSpy.mockRestore();
      historyGetSpy.mockRestore();
      historyUpsertSpy.mockRestore();
    }
  });

  // The credit-gate contract for a drained org / welcome-bonus-withheld signup:
  // the JSON-RPC bridge keeps the -32002 wire error (the /bridge route serves
  // raw JSON-RPC), while bridgeStream — whose callers are HTTP boundaries —
  // throws the typed 402 ApiError so routes translate it to a non-retryable
  // insufficient_credits response instead of a disguised transient failure.
  test("a failed shared-runtime turn releases the reservation and bills nothing", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = sharedSandbox();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
    runSharedAgentTurn.mockImplementationOnce(async () => {
      throw new Error("upstream model transport failed");
    });

    try {
      const response = await runWithCloudBindings({ CEREBRAS_API_KEY: "test-key" }, () =>
        new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
          jsonrpc: "2.0",
          id: "failed-turn",
          method: "message.send",
          params: { text: "hello" },
        }),
      );

      // The caller sees a bridge error, never a fabricated reply.
      expect(response.result).toBeUndefined();
      expect(response.error).toBeTruthy();
      // Billing correctness on the failure path: the credits reserved for the
      // turn are RELEASED (reconciled to zero usage), and nothing is billed or
      // recorded as usage — a failed turn must not charge the org.
      expect(reserveCredits).toHaveBeenCalledTimes(1);
      expect(reconcileReservation).toHaveBeenCalledWith(0);
      expect(billUsage).not.toHaveBeenCalled();
    } finally {
      findRunningSandboxSpy.mockRestore();
      historyGetSpy.mockRestore();
    }
  });

  test("credit-reserve rejection: bridge returns -32002, bridgeStream throws the typed 402", async () => {
    const { ElizaSandboxService, BRIDGE_INSUFFICIENT_CREDITS_CODE } = await import(
      "./eliza-sandbox.ts?actual"
    );
    const { InsufficientCreditsError: InsufficientCreditsApiError } = await import("../api/errors");
    const sandbox = sharedSandbox();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
    reserveCredits.mockImplementation(async () => {
      throw new MockInsufficientCreditsError(0.05, 0);
    });

    try {
      const rpc = {
        jsonrpc: "2.0" as const,
        id: "shared-turn",
        method: "message.send",
        params: { text: "hello" },
      };
      const service = new ElizaSandboxService();

      const response = await runWithCloudBindings({ CEREBRAS_API_KEY: "test-key" }, () =>
        service.bridge(sandbox.id, sandbox.organization_id, rpc),
      );
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "shared-turn",
        error: {
          code: BRIDGE_INSUFFICIENT_CREDITS_CODE,
          message: "Insufficient credits. Required: $0.0500, Available: $0.0000",
        },
      });
      expect(runSharedAgentTurn).not.toHaveBeenCalled();

      const streamRejection = runWithCloudBindings({ CEREBRAS_API_KEY: "test-key" }, () =>
        service.bridgeStream(sandbox.id, sandbox.organization_id, rpc),
      );
      await expect(streamRejection).rejects.toBeInstanceOf(InsufficientCreditsApiError);
      await expect(streamRejection).rejects.toMatchObject({
        code: "insufficient_credits",
        status: 402,
      });
    } finally {
      reserveCredits.mockImplementation(async () => ({
        reservedAmount: 0.002,
        reservationTransactionId: "reservation-1",
        reconcile: reconcileReservation,
      }));
      findRunningSandboxSpy.mockRestore();
      historyGetSpy.mockRestore();
    }
  });
});
