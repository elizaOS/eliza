/**
 * Price Alerts REST API Route Tests
 *
 * Tests GET/POST/DELETE /api/agents/[agentId]/alerts:
 * - Authentication and authorization (manager-only access)
 * - GET: list alerts (empty, populated)
 * - POST: create new alert, update existing, validation
 * - DELETE: by alertId, by tokenSymbol+condition, not found
 * - Edge cases: missing config, non-agent user, non-manager access
 *
 * Strategy: mock DB and auth; exercise real route handler code.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const MANAGER_USER_ID = "manager-001";
const AGENT_USER_ID = "agent-001";

const mockAuthenticateUser = mock(async () => ({
  id: MANAGER_USER_ID,
  userId: MANAGER_USER_ID,
}));

// DB mocks — fine-grained control per test
let usersQueryResult: unknown[] = [];
let configQueryResult: unknown[] = [];
let dbSelectCallIndex = 0;

const mockDbUpdateWhere = mock(async () => []);
const mockDbUpdateSet = mock((_setArg: Record<string, unknown>) => ({
  where: mockDbUpdateWhere,
}));
const mockDbUpdate = mock(() => ({ set: mockDbUpdateSet }));

function resetDbMocks() {
  dbSelectCallIndex = 0;
  usersQueryResult = [
    { id: AGENT_USER_ID, isAgent: true, managedBy: MANAGER_USER_ID },
  ];
  configQueryResult = [{ id: "cfg-1", priceAlerts: [] }];
  mockDbUpdateWhere.mockClear();
  mockDbUpdateSet.mockClear();
  mockDbUpdate.mockClear();
}

// The route does two sequential select queries:
// 1. users table (agent lookup)
// 2. userAgentConfigs (config lookup)
const mockDbSelectLimit = mock(async () => {
  dbSelectCallIndex++;
  if (dbSelectCallIndex === 1) return usersQueryResult;
  return configQueryResult;
});
const mockDbSelectWhere = mock(() => ({ limit: mockDbSelectLimit }));
const mockDbSelectFrom = mock(() => ({ where: mockDbSelectWhere }));
const mockDbSelect = mock(() => ({ from: mockDbSelectFrom }));

const _actualFeedApi = await import("@feed/api");
mock.module("@feed/api", () => ({
  ..._actualFeedApi,
  authenticateUser: mockAuthenticateUser,
  withErrorHandling: (
    handler: (req: NextRequest, ctx: unknown) => Promise<unknown>,
  ) => handler,
}));

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
  userAgentConfigs: {
    id: "userAgentConfigs.id",
    userId: "userAgentConfigs.userId",
    priceAlerts: "userAgentConfigs.priceAlerts",
  },
  users: {
    id: "users.id",
    isAgent: "users.isAgent",
    managedBy: "users.managedBy",
  },
}));

const _actualShared = await import("@feed/shared");
mock.module("@feed/shared", () => ({
  ..._actualShared,
  generateSnowflakeId: mock(async () => "snowflake-alert-api"),
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

const { GET, POST, DELETE } = await import(
  "@/app/api/agents/[agentId]/alerts/route"
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  method: string,
  body?: Record<string, unknown>,
  searchParams?: Record<string, string>,
): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/agents/${AGENT_USER_ID}/alerts`,
  );
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  return {
    method,
    url: url.toString(),
    headers: new Headers({ Authorization: "Bearer test-token" }),
    json: async () => body ?? {},
  } as unknown as NextRequest;
}

const routeContext = {
  params: Promise.resolve({ agentId: AGENT_USER_ID }),
};

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-001",
    tokenSymbol: "OPENAGI",
    condition: "below",
    threshold: 1.0,
    deliveryChannel: "team_chat",
    enabled: true,
    cooldownMinutes: 15,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Price Alerts API", () => {
  beforeEach(() => {
    resetDbMocks();
    mockAuthenticateUser.mockClear();
    mockAuthenticateUser.mockResolvedValue({
      id: MANAGER_USER_ID,
      userId: MANAGER_USER_ID,
    });
  });

  // ─── Authorization ───────────────────────────────────────────────────

  describe("authorization", () => {
    test("returns 404 when agent not found", async () => {
      usersQueryResult = []; // No agent

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toContain("Agent not found");
    });

    test("returns 404 when user is not an agent", async () => {
      usersQueryResult = [
        { id: AGENT_USER_ID, isAgent: false, managedBy: MANAGER_USER_ID },
      ];

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);

      expect(res.status).toBe(404);
    });

    test("returns 403 when caller is not the agent manager", async () => {
      usersQueryResult = [
        { id: AGENT_USER_ID, isAgent: true, managedBy: "other-owner" },
      ];

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);

      expect(res.status).toBe(403);
    });

    test("returns 404 when agent config not found", async () => {
      configQueryResult = []; // No config

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("configuration not found");
    });
  });

  // ─── GET ─────────────────────────────────────────────────────────────

  describe("GET /alerts", () => {
    test("returns empty alerts array", async () => {
      configQueryResult = [{ id: "cfg-1", priceAlerts: [] }];

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.alerts).toEqual([]);
    });

    test("returns populated alerts array", async () => {
      const alerts = [
        makeAlert(),
        makeAlert({ id: "a2", tokenSymbol: "TSLAI" }),
      ];
      configQueryResult = [{ id: "cfg-1", priceAlerts: alerts }];

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.alerts).toHaveLength(2);
    });

    test("returns null priceAlerts as empty array", async () => {
      configQueryResult = [{ id: "cfg-1", priceAlerts: null }];

      const req = makeRequest("GET");
      const res = await GET(req, routeContext);
      const body = await res.json();

      // priceAlerts: null → empty alerts (via ?? [])
      expect(body.alerts).toEqual([]);
    });
  });

  // ─── POST ────────────────────────────────────────────────────────────

  describe("POST /alerts", () => {
    test("returns 400 when tokenSymbol is missing", async () => {
      const req = makeRequest("POST", {
        condition: "below",
        threshold: 1.0,
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("returns 400 when condition is invalid", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "around",
        threshold: 1.0,
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("returns 400 when threshold is negative", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: -5,
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("returns 400 when threshold is zero", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 0,
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("returns 400 when threshold is not a number", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: "one dollar",
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("returns 400 when deliveryChannel=group but no deliveryChatId", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 1.0,
        deliveryChannel: "group",
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("deliveryChatId");
    });

    test("returns 400 when tokenSymbol is empty string", async () => {
      const req = makeRequest("POST", {
        tokenSymbol: "   ",
        condition: "below",
        threshold: 1.0,
      });
      const res = await POST(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("creates new alert with 201 status", async () => {
      configQueryResult = [{ id: "cfg-1", priceAlerts: [] }];

      const req = makeRequest("POST", {
        tokenSymbol: "openagi", // lowercase
        condition: "below",
        threshold: 1.0,
      });
      const res = await POST(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.alert.tokenSymbol).toBe("OPENAGI"); // Uppercased
      expect(body.alert.deliveryChannel).toBe("team_chat"); // Default
      expect(body.alert.cooldownMinutes).toBe(15); // Default
      expect(body.updated).toBe(false);
    });

    test("updates existing alert with 200 status", async () => {
      const existing = makeAlert({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 0.5,
        lastTriggeredAt: "2025-01-01T00:00:00.000Z",
      });
      configQueryResult = [{ id: "cfg-1", priceAlerts: [existing] }];

      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 0.8, // Updated threshold
      });
      const res = await POST(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.updated).toBe(true);
      expect(body.alert.threshold).toBe(0.8);
      expect(body.alert.lastTriggeredAt).toBeUndefined(); // Reset on update
    });

    test("creates alert with custom delivery and cooldown", async () => {
      configQueryResult = [{ id: "cfg-1", priceAlerts: [] }];

      const req = makeRequest("POST", {
        tokenSymbol: "TSLAI",
        condition: "above",
        threshold: 2.0,
        deliveryChannel: "group",
        deliveryChatId: "group-999",
        cooldownMinutes: 30,
      });
      const res = await POST(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.alert.deliveryChannel).toBe("group");
      expect(body.alert.deliveryChatId).toBe("group-999");
      expect(body.alert.cooldownMinutes).toBe(30);
    });

    test("does not duplicate when same token+condition exists", async () => {
      const existing = makeAlert({
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 0.5,
      });
      configQueryResult = [{ id: "cfg-1", priceAlerts: [existing] }];

      const req = makeRequest("POST", {
        tokenSymbol: "OPENAGI",
        condition: "below",
        threshold: 1.0,
      });
      await POST(req, routeContext);

      // Verify only 1 alert in the update (not 2)
      const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const alerts = setArg.priceAlerts as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
    });
  });

  // ─── DELETE ──────────────────────────────────────────────────────────

  describe("DELETE /alerts", () => {
    test("returns 400 when no identifier provided", async () => {
      const req = makeRequest("DELETE");
      const res = await DELETE(req, routeContext);

      expect(res.status).toBe(400);
    });

    test("deletes by alertId", async () => {
      const alerts = [
        makeAlert({ id: "a1" }),
        makeAlert({ id: "a2", tokenSymbol: "TSLAI" }),
      ];
      configQueryResult = [{ id: "cfg-1", priceAlerts: alerts }];

      const req = makeRequest("DELETE", undefined, { alertId: "a1" });
      const res = await DELETE(req, routeContext);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.removed.id).toBe("a1");

      // Verify a2 remains
      const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const remaining = setArg.priceAlerts as Array<Record<string, unknown>>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe("a2");
    });

    test("deletes by tokenSymbol", async () => {
      configQueryResult = [
        { id: "cfg-1", priceAlerts: [makeAlert({ tokenSymbol: "OPENAGI" })] },
      ];

      const req = makeRequest("DELETE", undefined, {
        tokenSymbol: "OPENAGI",
      });
      const res = await DELETE(req, routeContext);
      const body = await res.json();

      expect(body.success).toBe(true);
    });

    test("deletes by tokenSymbol + condition", async () => {
      const alerts = [
        makeAlert({ id: "a1", tokenSymbol: "OPENAGI", condition: "below" }),
        makeAlert({ id: "a2", tokenSymbol: "OPENAGI", condition: "above" }),
      ];
      configQueryResult = [{ id: "cfg-1", priceAlerts: alerts }];

      const req = makeRequest("DELETE", undefined, {
        tokenSymbol: "OPENAGI",
        condition: "above",
      });
      const res = await DELETE(req, routeContext);
      const body = await res.json();

      expect(body.removed.id).toBe("a2");
      const setArg = mockDbUpdateSet.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const remaining = setArg.priceAlerts as Array<Record<string, unknown>>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.condition).toBe("below");
    });

    test("returns 404 when alert not found by alertId", async () => {
      configQueryResult = [
        { id: "cfg-1", priceAlerts: [makeAlert({ id: "a1" })] },
      ];

      const req = makeRequest("DELETE", undefined, {
        alertId: "nonexistent",
      });
      const res = await DELETE(req, routeContext);

      expect(res.status).toBe(404);
    });

    test("returns 404 when alert not found by tokenSymbol", async () => {
      configQueryResult = [
        { id: "cfg-1", priceAlerts: [makeAlert({ tokenSymbol: "OPENAGI" })] },
      ];

      const req = makeRequest("DELETE", undefined, {
        tokenSymbol: "NONEXISTENT",
      });
      const res = await DELETE(req, routeContext);

      expect(res.status).toBe(404);
    });

    test("tokenSymbol matching is case-insensitive", async () => {
      configQueryResult = [
        { id: "cfg-1", priceAlerts: [makeAlert({ tokenSymbol: "OPENAGI" })] },
      ];

      const req = makeRequest("DELETE", undefined, {
        tokenSymbol: "openagi",
      });
      const res = await DELETE(req, routeContext);
      const body = await res.json();

      expect(body.success).toBe(true);
    });
  });
});
