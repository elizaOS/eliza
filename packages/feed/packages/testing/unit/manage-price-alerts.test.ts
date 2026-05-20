/**
 * Manage Price Alerts Action Tests
 *
 * Tests SET_PRICE_ALERT, LIST_PRICE_ALERTS, REMOVE_PRICE_ALERT actions:
 * - Parameter validation and error handling
 * - Create vs update logic (deduplication by tokenSymbol+condition)
 * - Token symbol uppercasing
 * - Cooldown reset on update
 * - List formatting (enabled/disabled, lastTriggeredAt)
 * - Removal by alertId vs tokenSymbol+condition
 * - Edge cases: empty arrays, missing config, invalid inputs
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

// ─── Mock Setup ──────────────────────────────────────────────────────────────

let mockDbSelectLimit: ReturnType<typeof mock>;
let mockDbSelectWhere: ReturnType<typeof mock>;
let mockDbSelectFrom: ReturnType<typeof mock>;
let mockDbSelect: ReturnType<typeof mock>;
let mockDbUpdateWhere: ReturnType<typeof mock>;
let mockDbUpdateSet: ReturnType<typeof mock>;
let mockDbUpdate: ReturnType<typeof mock>;

function resetDbMocks() {
  mockDbSelectLimit = mock(async () => []);
  mockDbSelectWhere = mock(() => ({ limit: mockDbSelectLimit }));
  mockDbSelectFrom = mock(() => ({ where: mockDbSelectWhere }));
  mockDbSelect = mock(() => ({ from: mockDbSelectFrom }));
  mockDbUpdateWhere = mock(async () => []);
  mockDbUpdateSet = mock(() => ({ where: mockDbUpdateWhere }));
  mockDbUpdate = mock(() => ({ set: mockDbUpdateSet }));
}

resetDbMocks();

const _actualDb = await import("@feed/db");
mock.module("@feed/db", () => ({
  ..._actualDb,
  db: {
    get select() {
      return mockDbSelect;
    },
    get update() {
      return mockDbUpdate;
    },
  },
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  count: () => "count",
  userAgentConfigs: {
    id: "userAgentConfigs.id",
    userId: "userAgentConfigs.userId",
    priceAlerts: "userAgentConfigs.priceAlerts",
  },
}));

const mockGenerateSnowflakeId = mock(async () => "snowflake-new-alert");

mock.module("../../agents/src/shared/snowflake", () => ({
  generateSnowflakeId: mockGenerateSnowflakeId,
}));

mock.module("../../agents/src/shared/logger", () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

const { setPriceAlertAction, listPriceAlertsAction, removePriceAlertAction } =
  await import(
    "../../agents/src/plugins/plugin-agent-core/src/actions/manage-price-alerts"
  );

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockRuntime = { agentId: "agent-001" } as unknown as IAgentRuntime;
const mockMessage = { content: { text: "test" } } as unknown as Memory;

function makeState(actionParams: Record<string, unknown>): State {
  return { data: { actionParams } } as unknown as State;
}

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-001",
    tokenSymbol: "OPENAGI",
    condition: "below",
    threshold: 1.0,
    deliveryChannel: "team_chat",
    deliveryChatId: undefined,
    enabled: true,
    lastTriggeredAt: undefined,
    cooldownMinutes: 15,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── SET_PRICE_ALERT ─────────────────────────────────────────────────────────

describe("setPriceAlertAction", () => {
  beforeEach(() => {
    resetDbMocks();
    mockGenerateSnowflakeId.mockClear();
    mockGenerateSnowflakeId.mockResolvedValue("snowflake-new-alert");
  });

  test("returns error when actionParams is missing", async () => {
    const result = await setPriceAlertAction.handler(mockRuntime, mockMessage, {
      data: {},
    } as unknown as State);
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("Missing parameters");
  });

  test("returns error when tokenSymbol is missing", async () => {
    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ condition: "below", threshold: 1.0 }),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("Missing required parameters");
  });

  test("returns error when condition is invalid", async () => {
    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "around",
        threshold: 1.0,
      }),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain('must be "above" or "below"');
  });

  test("returns error when threshold is zero", async () => {
    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ tokenSymbol: "OPENAGI", condition: "below", threshold: 0 }),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("positive number");
  });

  test("returns error when threshold is negative", async () => {
    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: -5.0,
      }),
    );
    expect(result?.success).toBe(false);
  });

  test("returns error when threshold is not a number", async () => {
    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: "one dollar",
      }),
    );
    expect(result?.success).toBe(false);
  });

  test("returns error when deliveryChannel=group but no deliveryChatId", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: "cfg-1", priceAlerts: [] }]);

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 1.0,
        deliveryChannel: "group",
      }),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("deliveryChatId is required");
  });

  test("returns error when agent config not found", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]); // No config

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 1.0,
      }),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("configuration not found");
  });

  test("creates new alert with defaults", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: "cfg-1", priceAlerts: [] }]);

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "openagi", // lowercase — should be uppercased
        condition: "below",
        threshold: 1.0,
      }),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("OPENAGI"); // Uppercased
    expect(result?.text).toContain("below");
    expect(result?.text).toContain("team_chat"); // Default delivery
    expect(result?.data?.created).toBe(true);

    // Verify DB update was called
    expect(mockDbUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const alerts = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.tokenSymbol).toBe("OPENAGI");
    expect(alerts[0]?.cooldownMinutes).toBe(15); // Default
  });

  test("creates alert with custom cooldown and group delivery", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: "cfg-1", priceAlerts: [] }]);

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "TSLAI",
        condition: "above",
        threshold: 2.0,
        deliveryChannel: "group",
        deliveryChatId: "group-chat-999",
        cooldownMinutes: 30,
      }),
    );

    expect(result?.success).toBe(true);
    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const alerts = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(alerts[0]?.deliveryChannel).toBe("group");
    expect(alerts[0]?.deliveryChatId).toBe("group-chat-999");
    expect(alerts[0]?.cooldownMinutes).toBe(30);
  });

  test("updates existing alert with same tokenSymbol+condition", async () => {
    const existingAlert = makeAlert({
      id: "existing-alert",
      tokenSymbol: "OPENAGI",
      condition: "below",
      threshold: 0.5,
      lastTriggeredAt: "2025-01-01T00:00:00.000Z",
    });

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: [existingAlert] },
    ]);

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 0.8, // New threshold
      }),
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.updated).toBe(true);

    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const alerts = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1); // Still 1 alert (updated, not added)
    expect(alerts[0]?.threshold).toBe(0.8);
    expect(alerts[0]?.lastTriggeredAt).toBeUndefined(); // Reset on update
    expect(alerts[0]?.enabled).toBe(true); // Re-enabled on update
  });

  test("preserves other alerts when updating one", async () => {
    const alerts = [
      makeAlert({ id: "a1", tokenSymbol: "OPENAGI", condition: "below" }),
      makeAlert({ id: "a2", tokenSymbol: "TSLAI", condition: "above" }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 2.0,
      }),
    );

    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const updatedAlerts = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(updatedAlerts).toHaveLength(2);
    expect(updatedAlerts.find((a) => a.id === "a2")?.threshold).toBe(1.0); // Unchanged
  });

  test("accepts very small positive threshold", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ id: "cfg-1", priceAlerts: [] }]);

    const result = await setPriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({
        tokenSymbol: "MICRO",
        condition: "below",
        threshold: 0.000001,
      }),
    );

    expect(result?.success).toBe(true);
  });
});

// ─── LIST_PRICE_ALERTS ───────────────────────────────────────────────────────

describe("listPriceAlertsAction", () => {
  beforeEach(() => {
    resetDbMocks();
  });

  test("returns message when no alerts configured", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [] }]);

    const result = await listPriceAlertsAction.handler(
      mockRuntime,
      mockMessage,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("No price alerts configured");
    expect(result?.data?.alerts).toEqual([]);
  });

  test("returns message when config has null priceAlerts", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: null }]);

    const result = await listPriceAlertsAction.handler(
      mockRuntime,
      mockMessage,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("No price alerts configured");
  });

  test("returns message when no config exists", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    const result = await listPriceAlertsAction.handler(
      mockRuntime,
      mockMessage,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("No price alerts");
  });

  test("lists alerts with status indicators", async () => {
    const alerts = [
      makeAlert({
        id: "a1",
        enabled: true,
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 1.0,
      }),
      makeAlert({
        id: "a2",
        enabled: false,
        tokenSymbol: "TSLAI",
        condition: "above",
        threshold: 2.0,
      }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: alerts }]);

    const result = await listPriceAlertsAction.handler(
      mockRuntime,
      mockMessage,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("2)"); // Count
    expect(result?.text).toContain("[✓]"); // Enabled
    expect(result?.text).toContain("[✗]"); // Disabled
    expect(result?.text).toContain("OPENAGI");
    expect(result?.text).toContain("TSLAI");
    expect(result?.data?.alerts).toHaveLength(2);
  });

  test("shows lastTriggeredAt when present", async () => {
    const alerts = [makeAlert({ lastTriggeredAt: "2025-06-15T10:30:00.000Z" })];

    mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: alerts }]);

    const result = await listPriceAlertsAction.handler(
      mockRuntime,
      mockMessage,
    );

    expect(result?.text).toContain("last triggered");
  });
});

// ─── REMOVE_PRICE_ALERT ──────────────────────────────────────────────────────

describe("removePriceAlertAction", () => {
  beforeEach(() => {
    resetDbMocks();
  });

  test("returns error when no params provided", async () => {
    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      { data: {} } as unknown as State,
    );
    expect(result?.success).toBe(false);
  });

  test("returns error when neither alertId nor tokenSymbol provided", async () => {
    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({}),
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("alertId or tokenSymbol");
  });

  test("removes alert by alertId", async () => {
    const alerts = [
      makeAlert({ id: "a1" }),
      makeAlert({ id: "a2", tokenSymbol: "TSLAI" }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ alertId: "a1" }),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Removed price alert");
    expect(result?.text).toContain("OPENAGI");

    // Verify only a2 remains
    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const remaining = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("a2");
  });

  test("removes alert by tokenSymbol (case-insensitive)", async () => {
    const alerts = [
      makeAlert({ id: "a1", tokenSymbol: "OPENAGI", condition: "below" }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ tokenSymbol: "openagi" }), // lowercase
    );

    expect(result?.success).toBe(true);
  });

  test("removes alert by tokenSymbol + condition", async () => {
    const alerts = [
      makeAlert({ id: "a1", tokenSymbol: "OPENAGI", condition: "below" }),
      makeAlert({ id: "a2", tokenSymbol: "OPENAGI", condition: "above" }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ tokenSymbol: "OPENAGI", condition: "above" }),
    );

    expect(result?.success).toBe(true);
    const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const remaining = setArg.priceAlerts as Array<Record<string, unknown>>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("a1"); // 'below' alert preserved
  });

  test("returns error when alert not found by alertId", async () => {
    const alerts = [makeAlert({ id: "a1" })];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ alertId: "nonexistent" }),
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("No matching price alert");
  });

  test("returns error when alert not found by tokenSymbol", async () => {
    const alerts = [makeAlert({ id: "a1", tokenSymbol: "OPENAGI" })];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ tokenSymbol: "NONEXISTENT" }),
    );

    expect(result?.success).toBe(false);
  });

  test("returns error when config not found", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]); // No config

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ alertId: "a1" }),
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("configuration not found");
  });

  test("removes first matching alert when no condition specified", async () => {
    const alerts = [
      makeAlert({ id: "a1", tokenSymbol: "OPENAGI", condition: "below" }),
      makeAlert({ id: "a2", tokenSymbol: "OPENAGI", condition: "above" }),
    ];

    mockDbSelectLimit.mockResolvedValueOnce([
      { id: "cfg-1", priceAlerts: alerts },
    ]);

    const result = await removePriceAlertAction.handler(
      mockRuntime,
      mockMessage,
      makeState({ tokenSymbol: "OPENAGI" }), // No condition
    );

    expect(result?.success).toBe(true);
    // Should remove first match (a1)
    expect((result?.data?.removedAlert as Record<string, unknown>)?.id).toBe(
      "a1",
    );
  });
});
