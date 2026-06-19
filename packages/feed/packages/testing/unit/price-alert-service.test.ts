/**
 * PriceAlertService Unit Tests
 *
 * Tests the core price alert checking logic:
 * - checkAlerts: main entry, cooldown enforcement, delivery routing
 * - getCurrentPrice: markPrice vs currentPrice fallback
 * - formatAlertMessage: message formatting, percentage calculation
 * - updateAlertTimestamp: timestamp persistence
 *
 * Strategy: mock DB, executeDirectMessage, and teamChatService;
 * exercise real PriceAlertService code paths.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mock Setup ──────────────────────────────────────────────────────────────

// DB chain mocks — we rebuild per-test to control return values
let mockDbSelectLimit: ReturnType<typeof mock>;
let mockDbSelectWhere: ReturnType<typeof mock>;
let mockDbSelectFrom: ReturnType<typeof mock>;
let mockDbSelect: ReturnType<typeof mock>;
let mockDbUpdateSet: ReturnType<typeof mock>;
let mockDbUpdateWhere: ReturnType<typeof mock>;
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

const mockExecuteDirectMessage = mock(
  async () =>
    ({ success: true, messageId: "msg-123" }) as Record<string, unknown>,
);

const mockGetTeamChat = mock(
  async () => ({ chatId: "team-chat-001" }) as Record<string, unknown> | null,
);

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
  desc: (col: unknown) => ({ op: "desc", col }),
  gte: (a: unknown, b: unknown) => ({ op: "gte", a, b }),
  ilike: (col: unknown, val: unknown) => ({ op: "ilike", col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  lte: (a: unknown, b: unknown) => ({ op: "lte", a, b }),
  ne: (a: unknown, b: unknown) => ({ op: "ne", a, b }),
  sql: Object.assign((...args: unknown[]) => args, { raw: (s: string) => s }),
  getDbInstance: () => ({}),
  getRawDrizzle: () => ({}),
  chats: {
    id: "chats.id",
    name: "chats.name",
    groupId: "chats.groupId",
    isGroup: "chats.isGroup",
  },
  chatParticipants: {
    chatId: "chatParticipants.chatId",
    userId: "chatParticipants.userId",
  },
  groups: { id: "groups.id", name: "groups.name" },
  markets: { id: "markets.id" },
  posts: {
    id: "posts.id",
    authorId: "posts.authorId",
    content: "posts.content",
    timestamp: "posts.timestamp",
    deletedAt: "posts.deletedAt",
  },
  comments: { id: "comments.id" },
  reactions: { id: "reactions.id" },
  shares: { id: "shares.id" },
  positions: { id: "positions.id" },
  perpPositions: { id: "perpPositions.id" },
  perpMarketSnapshots: {
    currentPrice: "perpMarketSnapshots.currentPrice",
    markPrice: "perpMarketSnapshots.markPrice",
    ticker: "perpMarketSnapshots.ticker",
  },
  userAgentConfigs: {
    id: "userAgentConfigs.id",
    userId: "userAgentConfigs.userId",
    priceAlerts: "userAgentConfigs.priceAlerts",
  },
  users: {
    id: "users.id",
    managedBy: "users.managedBy",
  },
}));

mock.module("../../agents/src/autonomous/DirectExecutors", () => ({
  executeDirectMessage: mockExecuteDirectMessage,
}));

mock.module("../../agents/src/services/TeamChatService", () => ({
  teamChatService: { getTeamChat: mockGetTeamChat },
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

const { PriceAlertService } = await import(
  "../../agents/src/autonomous/PriceAlertService"
);

// Type for accessing private methods in tests
type ServicePrivate = {
  formatAlertMessage: (alert: Record<string, unknown>, price: number) => string;
  getCurrentPrice: (symbol: string) => Promise<number | null>;
  getOwnerTeamChatId: (agentId: string) => Promise<string | undefined>;
  updateAlertTimestamp: (agentId: string, alertId: string) => Promise<void>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PriceAlertService", () => {
  let service: InstanceType<typeof PriceAlertService>;

  beforeEach(() => {
    service = new PriceAlertService();
    resetDbMocks();
    mockExecuteDirectMessage.mockClear();
    mockGetTeamChat.mockClear();
    mockExecuteDirectMessage.mockImplementation(async () => ({
      success: true,
      messageId: "msg-123",
    }));
    mockGetTeamChat.mockImplementation(async () => ({
      chatId: "team-chat-001",
    }));
  });

  // ═══ checkAlerts ═══════════════════════════════════════════════════════

  describe("checkAlerts", () => {
    test("returns 0 when agent has no config", async () => {
      // First query (config lookup) returns empty
      mockDbSelectLimit.mockResolvedValueOnce([]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("returns 0 when priceAlerts is null", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: null }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("returns 0 when priceAlerts is empty array", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [] }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("returns 0 when all alerts are disabled", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([
        { priceAlerts: [makeAlert({ enabled: false })] },
      ]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("skips alert still in cooldown", async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      mockDbSelectLimit.mockResolvedValueOnce([
        {
          priceAlerts: [
            makeAlert({ cooldownMinutes: 15, lastTriggeredAt: recentTime }),
          ],
        },
      ]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
      // Should never reach price check
      expect(mockDbSelect).toHaveBeenCalledTimes(1); // only config query
    });

    test("processes alert when cooldown has elapsed", async () => {
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
      const alert = makeAlert({
        cooldownMinutes: 15,
        lastTriggeredAt: oldTime,
        condition: "below",
        threshold: 1.0,
      });

      // Call 1: config lookup
      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      // Call 2: price lookup — price below threshold
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.8, currentPrice: 0.85 },
      ]);
      // Call 3: owner lookup
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(1);
      expect(mockExecuteDirectMessage).toHaveBeenCalledTimes(1);
    });

    test("skips alert when current price is null (token not found)", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [makeAlert()] }]);
      // Price lookup returns empty
      mockDbSelectLimit.mockResolvedValueOnce([]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
      expect(mockExecuteDirectMessage).not.toHaveBeenCalled();
    });

    test("triggers alert when price is below threshold (condition=below)", async () => {
      const alert = makeAlert({
        condition: "below",
        threshold: 1.0,
      });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.5, currentPrice: 0.6 },
      ]);
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(1);
    });

    test("does NOT trigger when price is above threshold (condition=below)", async () => {
      const alert = makeAlert({ condition: "below", threshold: 1.0 });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      // Price is ABOVE threshold — should NOT trigger
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 1.5, currentPrice: 1.5 },
      ]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("triggers alert when price is above threshold (condition=above)", async () => {
      const alert = makeAlert({ condition: "above", threshold: 2.0 });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 2.5, currentPrice: 2.4 },
      ]);
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(1);
    });

    test("does NOT trigger when price equals threshold exactly", async () => {
      const alert = makeAlert({ condition: "below", threshold: 1.0 });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      // Price equals threshold — strictly not below
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 1.0, currentPrice: 1.0 },
      ]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
    });

    test("uses group chat delivery when deliveryChannel=group", async () => {
      const alert = makeAlert({
        deliveryChannel: "group",
        deliveryChatId: "group-chat-999",
        condition: "below",
        threshold: 1.0,
      });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.5, currentPrice: 0.5 },
      ]);
      // No owner lookup needed — goes directly to group chat

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(1);
      expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "group-chat-999" }),
      );
    });

    test("falls back to team_chat when deliveryChannel=group but no deliveryChatId", async () => {
      const alert = makeAlert({
        deliveryChannel: "group",
        deliveryChatId: undefined,
        condition: "below",
        threshold: 1.0,
      });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.5, currentPrice: 0.5 },
      ]);
      // Falls through to team chat lookup
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(1);
      expect(mockExecuteDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "team-chat-001" }),
      );
    });

    test("skips alert when no delivery channel can be resolved", async () => {
      const alert = makeAlert({ condition: "below", threshold: 1.0 });

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: [alert] }]);
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.5, currentPrice: 0.5 },
      ]);
      // Owner has no managedBy
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: null }]);

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(0);
      expect(mockExecuteDirectMessage).not.toHaveBeenCalled();
    });

    test("continues processing after a failed message send", async () => {
      const alert1 = makeAlert({
        id: "a1",
        condition: "below",
        threshold: 2.0,
      });
      const alert2 = makeAlert({
        id: "a2",
        tokenSymbol: "TSLAI",
        condition: "above",
        threshold: 1.0,
      });

      mockDbSelectLimit.mockResolvedValueOnce([
        { priceAlerts: [alert1, alert2] },
      ]);
      // Price for alert1
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 1.0, currentPrice: 1.0 },
      ]);
      // Owner for alert1
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      // First send fails
      mockExecuteDirectMessage.mockResolvedValueOnce({
        success: false,
        error: "Rate limited",
      });

      // Price for alert2
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 1.5, currentPrice: 1.5 },
      ]);
      // Owner for alert2
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      // Second send succeeds
      mockExecuteDirectMessage.mockResolvedValueOnce({
        success: true,
        messageId: "msg-456",
      });

      const result = await service.checkAlerts("agent-001");
      // Only 1 success (alert2), alert1 failed
      expect(result).toBe(1);
      expect(mockExecuteDirectMessage).toHaveBeenCalledTimes(2);
    });

    test("handles multiple enabled alerts in one pass", async () => {
      const alerts = [
        makeAlert({
          id: "a1",
          tokenSymbol: "OPENAGI",
          condition: "below",
          threshold: 1.0,
        }),
        makeAlert({
          id: "a2",
          tokenSymbol: "TSLAI",
          condition: "above",
          threshold: 0.5,
        }),
        makeAlert({
          id: "a3",
          tokenSymbol: "ETH",
          condition: "below",
          threshold: 100.0,
          enabled: false,
        }),
      ];

      mockDbSelectLimit.mockResolvedValueOnce([{ priceAlerts: alerts }]);

      // alert1: price check (below threshold)
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.8, currentPrice: 0.9 },
      ]);
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      // alert2: price check (above threshold)
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0.7, currentPrice: 0.6 },
      ]);
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);

      // alert3 is disabled, should be skipped

      const result = await service.checkAlerts("agent-001");
      expect(result).toBe(2); // both enabled alerts triggered
      expect(mockExecuteDirectMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ═══ formatAlertMessage ════════════════════════════════════════════════

  describe("formatAlertMessage", () => {
    test('formats "dropped below" message correctly', () => {
      const alert = makeAlert({
        condition: "below",
        threshold: 1.0,
        tokenSymbol: "OPENAGI",
      });
      // Access private method via bracket notation
      const message = (service as unknown as ServicePrivate).formatAlertMessage(
        alert,
        0.8,
      );

      expect(message).toContain("📉");
      expect(message).toContain("OPENAGI");
      expect(message).toContain("dropped below");
      expect(message).toContain("$1");
      expect(message).toContain("$0.80");
      expect(message).toContain("below threshold");
    });

    test('formats "rose above" message correctly', () => {
      const alert = makeAlert({
        condition: "above",
        threshold: 2.0,
        tokenSymbol: "TSLAI",
      });
      const message = (service as unknown as ServicePrivate).formatAlertMessage(
        alert,
        2.5,
      );

      expect(message).toContain("📈");
      expect(message).toContain("TSLAI");
      expect(message).toContain("rose above");
      expect(message).toContain("$2");
      expect(message).toContain("above threshold");
    });

    test("calculates percentage difference correctly", () => {
      const alert = makeAlert({ condition: "below", threshold: 100.0 });
      const message = (service as unknown as ServicePrivate).formatAlertMessage(
        alert,
        80.0,
      );

      // Diff = 20, pctDiff = (20/100)*100 = 20.0%
      expect(message).toContain("20.0%");
    });

    test("handles zero percentage difference (price = threshold)", () => {
      const alert = makeAlert({ condition: "below", threshold: 1.0 });
      const message = (service as unknown as ServicePrivate).formatAlertMessage(
        alert,
        1.0,
      );

      expect(message).toContain("0.0%");
    });

    test("handles very small prices with proper formatting", () => {
      const alert = makeAlert({ condition: "below", threshold: 0.001 });
      const message = (service as unknown as ServicePrivate).formatAlertMessage(
        alert,
        0.0005,
      );

      expect(message).toContain("$0.00"); // toFixed(2)
    });
  });

  // ═══ getCurrentPrice ═══════════════════════════════════════════════════

  describe("getCurrentPrice", () => {
    test("returns markPrice when available", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 1.5, currentPrice: 1.4 },
      ]);

      const price = await (
        service as unknown as ServicePrivate
      ).getCurrentPrice("OPENAGI");
      expect(price).toBe(1.5);
    });

    test("falls back to currentPrice when markPrice is null", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: null, currentPrice: 1.4 },
      ]);

      const price = await (
        service as unknown as ServicePrivate
      ).getCurrentPrice("OPENAGI");
      expect(price).toBe(1.4);
    });

    test("returns null when both prices are null", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: null, currentPrice: null },
      ]);

      const price = await (
        service as unknown as ServicePrivate
      ).getCurrentPrice("OPENAGI");
      expect(price).toBeNull();
    });

    test("returns null when token not found", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([]);

      const price = await (
        service as unknown as ServicePrivate
      ).getCurrentPrice("NONEXISTENT");
      expect(price).toBeNull();
    });

    test("returns markPrice of 0 without falling back", async () => {
      // markPrice=0 is falsy but should still be used (it's a valid price)
      // However, ?? operator treats 0 as truthy, so this should return 0
      mockDbSelectLimit.mockResolvedValueOnce([
        { markPrice: 0, currentPrice: 5.0 },
      ]);

      const price = await (
        service as unknown as ServicePrivate
      ).getCurrentPrice("ZERO_TOKEN");
      expect(price).toBe(0);
    });
  });

  // ═══ getOwnerTeamChatId ════════════════════════════════════════════════

  describe("getOwnerTeamChatId", () => {
    test("returns team chat ID for agent with owner", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);
      mockGetTeamChat.mockResolvedValueOnce({ chatId: "team-chat-001" });

      const chatId = await (
        service as unknown as ServicePrivate
      ).getOwnerTeamChatId("agent-001");
      expect(chatId).toBe("team-chat-001");
    });

    test("returns undefined when agent has no managedBy", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: null }]);

      const chatId = await (
        service as unknown as ServicePrivate
      ).getOwnerTeamChatId("agent-001");
      expect(chatId).toBeUndefined();
    });

    test("returns undefined when agent not found in DB", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([]);

      const chatId = await (
        service as unknown as ServicePrivate
      ).getOwnerTeamChatId("nonexistent");
      expect(chatId).toBeUndefined();
    });

    test("returns undefined when teamChatService returns null", async () => {
      mockDbSelectLimit.mockResolvedValueOnce([{ managedBy: "owner-001" }]);
      mockGetTeamChat.mockResolvedValueOnce(null);

      const chatId = await (
        service as unknown as ServicePrivate
      ).getOwnerTeamChatId("agent-001");
      expect(chatId).toBeUndefined();
    });
  });

  // ═══ updateAlertTimestamp ══════════════════════════════════════════════
  // The implementation uses an atomic SQL JSONB update (no SELECT needed).

  describe("updateAlertTimestamp", () => {
    test("issues atomic UPDATE with SQL expression", async () => {
      await (service as unknown as ServicePrivate).updateAlertTimestamp(
        "agent-001",
        "a1",
      );

      // Should call db.update().set().where() — single atomic operation, no SELECT
      expect(mockDbUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockDbSelect).not.toHaveBeenCalled();

      const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // priceAlerts is now a SQL template expression (not a plain array)
      expect(setArg.priceAlerts).toBeDefined();
      expect(setArg.updatedAt).toBeInstanceOf(Date);
    });

    test("does not throw when no matching config exists", async () => {
      // Atomic UPDATE on non-existent row simply affects 0 rows — no error
      await expect(
        (service as unknown as ServicePrivate).updateAlertTimestamp(
          "nonexistent",
          "a1",
        ),
      ).resolves.toBeUndefined();

      expect(mockDbUpdateSet).toHaveBeenCalledTimes(1);
    });
  });
});
