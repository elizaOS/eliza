import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { cache } from "../cache/client";
import { runWithCloudBindings } from "../runtime/cloud-bindings";

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

mock.module("./ai-billing", () => ({
  reserveCredits,
  billUsage,
  recordUsageAnalytics,
  estimateInputTokens,
  InsufficientCreditsError: MockInsufficientCreditsError,
}));

const aiBillingRecord = mock(async () => ({ id: "ai-billing-1" }));

mock.module("./ai-billing-records", () => ({
  aiBillingRecordsService: {
    record: aiBillingRecord,
  },
}));

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

mock.module("./shared-runtime/run-shared-agent-turn", () => ({
  runSharedAgentTurn,
  resolveSharedAgentTurnModel,
}));

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
    neon_project_id: null,
    neon_branch_id: null,
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

afterEach(() => {
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
  test("meters successful shared-runtime turns", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox");
    const sandbox = sharedSandbox();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const cacheGetSpy = spyOn(cache, "get").mockResolvedValue([]);
    const cacheSetSpy = spyOn(cache, "set").mockResolvedValue(undefined);

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
      expect(cacheGetSpy).toHaveBeenCalled();
      expect(cacheSetSpy).toHaveBeenCalled();
    } finally {
      findRunningSandboxSpy.mockRestore();
      cacheGetSpy.mockRestore();
      cacheSetSpy.mockRestore();
    }
  });
});
