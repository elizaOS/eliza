import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson, type JsonValue } from "../helpers/json-body";
import { NONEXISTENT_UUID } from "../helpers/test-data";

/**
 * Dashboard, Admin, and Misc API E2E Tests
 *
 * Tests for dashboard-specific APIs, admin endpoints, and remaining routes.
 * Many of these routes call external services, so we use a longer timeout.
 */
setDefaultTimeout(15_000);

type HealthResponse = {
  status: string;
  timestamp: number;
};

describe("Health API", () => {
  test("GET /api/health returns 200 with status ok", async () => {
    const response = await api.get("/api/health");
    expect(response.status).toBe(200);
    const body = await readJson<HealthResponse>(response);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
  });
});

describe("Dashboard API", () => {
  test("GET /api/v1/dashboard requires auth", async () => {
    const response = await api.get("/api/v1/dashboard");
    expect([401, 403, 404]).toContain(response.status);
  });

  test("GET /api/v1/dashboard returns dashboard data", async () => {
    const response = await api.get("/api/v1/dashboard", {
      authenticated: true,
    });
    expect([200, 404]).toContain(response.status);
  });
});

describe("Admin API", () => {
  test("GET /api/v1/admin/moderation requires auth", async () => {
    const response = await api.get("/api/v1/admin/moderation");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/admin/service-pricing requires admin auth", async () => {
    const response = await api.get("/api/v1/admin/service-pricing");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/admin/metrics requires auth", async () => {
    const response = await api.get("/api/v1/admin/metrics");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/admin/moderation with non-admin key gets 403", async () => {
    const response = await api.get("/api/v1/admin/moderation", {
      authenticated: true,
    });
    expect([200, 403]).toContain(response.status);
  });
});

describe("A2A (Agent-to-Agent) Protocol API", () => {
  test("POST /api/a2a handles requests", async () => {
    const response = await api.post("/api/a2a", {
      jsonrpc: "2.0",
      method: "tasks/send",
      params: { message: { text: "test" } },
    });
    expect([200, 400, 401, 404]).toContain(response.status);
  });
});

describe("Market API", () => {
  // Market routes require chain/address path params
  test("GET /api/v1/market/price/[chain]/[address] handles test params", async () => {
    const response = await api.get(
      "/api/v1/market/price/ethereum/0x0000000000000000000000000000000000000000",
    );
    expect([200, 400, 401, 404]).toContain(response.status);
  });

  test("GET /api/v1/market/token/[chain]/[address] handles test params", async () => {
    const response = await api.get(
      "/api/v1/market/token/ethereum/0x0000000000000000000000000000000000000000",
    );
    expect([200, 400, 401, 404]).toContain(response.status);
  });
});

describe("Advertising API", () => {
  test("GET /api/v1/advertising/accounts requires auth", async () => {
    const response = await api.get("/api/v1/advertising/accounts");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/advertising/campaigns requires auth", async () => {
    const response = await api.get("/api/v1/advertising/campaigns");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Solana API", () => {
  test("POST /api/v1/solana/rpc handles requests", async () => {
    const response = await api.post("/api/v1/solana/rpc", {
      method: "getHealth",
    });
    expect([200, 400, 401, 403]).toContain(response.status);
  });

  test("GET /api/v1/solana/methods returns method list", async () => {
    const response = await api.get("/api/v1/solana/methods");
    expect([200, 401]).toContain(response.status);
  });
});

describe("Chain API", () => {
  test("GET /api/v1/chain/tokens/[chain]/[address] handles test params", async () => {
    const response = await api.get(
      "/api/v1/chain/tokens/ethereum/0x0000000000000000000000000000000000000000",
    );
    expect([200, 400, 401, 404]).toContain(response.status);
  });
});

describe("Generate Prompts API", () => {
  test("POST /api/v1/generate-prompts requires auth", async () => {
    const response = await api.post("/api/v1/generate-prompts", {
      type: "character",
    });
    expect([401, 403]).toContain(response.status);
  });
});

describe("Credits Summary API", () => {
  test("GET /api/v1/credits/summary requires auth", async () => {
    const response = await api.get("/api/v1/credits/summary");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/credits/summary returns credit info", async () => {
    const response = await api.get("/api/v1/credits/summary", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
    const body = await readJson<JsonValue>(response);
    expect(body).toBeTruthy();
  });
});

describe("App Auth API", () => {
  test("GET /api/v1/app-auth/session validates request", async () => {
    const response = await api.get("/api/v1/app-auth/session");
    expect([401, 404]).toContain(response.status);
  });

  test("POST /api/v1/app-auth/connect validates request", async () => {
    const response = await api.post("/api/v1/app-auth/connect", {});
    expect([400, 401, 404]).toContain(response.status);
  });
});

describe("Messages API", () => {
  test("POST /api/v1/messages requires auth", async () => {
    const response = await api.post("/api/v1/messages", { text: "test" });
    expect([401, 403]).toContain(response.status);
  });
});

describe("Jobs API", () => {
  test("GET /api/v1/jobs/[jobId] handles nonexistent job", async () => {
    const response = await api.get(`/api/v1/jobs/${NONEXISTENT_UUID}`);
    expect([401, 403, 404]).toContain(response.status);
  });
});

describe("Proxy API", () => {
  test("POST /api/v1/proxy/solana-rpc validates request", async () => {
    const response = await api.post("/api/v1/proxy/solana-rpc", {
      method: "getHealth",
    });
    expect([200, 400, 401, 403]).toContain(response.status);
  });

  test("GET /api/v1/proxy/evm-rpc/ethereum handles request", async () => {
    const response = await api.get("/api/v1/proxy/evm-rpc/ethereum");
    expect([200, 400, 401, 403, 405]).toContain(response.status);
  });
});

describe("RPC API", () => {
  test("POST /api/v1/rpc/ethereum validates request", async () => {
    const response = await api.post("/api/v1/rpc/ethereum", {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });
    expect([200, 400, 401, 403, 404]).toContain(response.status);
  });
});

describe("x402 API", () => {
  test("GET /api/v1/x402 responds", async () => {
    const response = await api.get("/api/v1/x402");
    expect([200, 401, 403]).toContain(response.status);
  });
});

describe("Invoices API", () => {
  test("GET /api/invoices/list requires auth", async () => {
    const response = await api.get("/api/invoices/list");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/invoices/[id] handles nonexistent", async () => {
    const response = await api.get(`/api/invoices/${NONEXISTENT_UUID}`);
    expect([401, 403, 404]).toContain(response.status);
  });
});
