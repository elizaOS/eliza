import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type SignTransactionInput,
  StewardApiError,
  StewardClient,
  type StewardClientConfig,
} from "../client";
import type { PolicyRule } from "../types";

// ─── Fetch Mocking Helpers ────────────────────────────────────────────────

type FetchFn = typeof fetch;

let originalFetch: FetchFn;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let lastCapture: CapturedRequest | null = null;

function installMockFetch(responseBody: object, status = 200): void {
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    lastCapture = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function installNetworkErrorFetch(): void {
  global.fetch = async () => {
    throw new Error("Network error: connection refused");
  };
}

function installBadJsonFetch(status = 200): void {
  global.fetch = async () =>
    new Response("this is not json", {
      status,
      headers: { "Content-Type": "text/plain" },
    });
}

beforeEach(() => {
  originalFetch = global.fetch;
  lastCapture = null;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Helper factories ─────────────────────────────────────────────────────

function makeClient(overrides: Partial<StewardClientConfig> = {}): StewardClient {
  return new StewardClient({
    baseUrl: "https://api.steward.example",
    ...overrides,
  });
}

const mockAgent = {
  id: "agent-1",
  tenantId: "tenant-1",
  name: "Test Agent",
  walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
  createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
};

const mockPolicy: PolicyRule = {
  id: "rule-1",
  type: "spending-limit",
  enabled: true,
  config: { maxPerTx: "1000000000000000000" },
};

// ─── Construction Tests ───────────────────────────────────────────────────

describe("StewardClient construction", () => {
  it("creates a client with minimal config (baseUrl only)", () => {
    const client = new StewardClient({ baseUrl: "https://api.example.com" });
    expect(client).toBeInstanceOf(StewardClient);
  });

  it("strips trailing slash from baseUrl", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const client = new StewardClient({ baseUrl: "https://api.example.com///" });
    await client.listAgents();
    expect(lastCapture?.url).not.toContain("///agents");
    expect(lastCapture?.url).toMatch(/\/agents$/);
  });

  it("creates a client with all config options", () => {
    const client = new StewardClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-api-key",
      bearerToken: "test-bearer-token",
      tenantId: "test-tenant",
    });
    expect(client).toBeInstanceOf(StewardClient);
  });

  it("creates a client with apiKey only", () => {
    const client = new StewardClient({
      baseUrl: "https://api.example.com",
      apiKey: "my-api-key",
    });
    expect(client).toBeInstanceOf(StewardClient);
  });
});

// ─── Header Tests ─────────────────────────────────────────────────────────

describe("Request headers", () => {
  it("always sends Content-Type: application/json", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    await makeClient().listAgents();
    expect(lastCapture?.headers["content-type"]).toBe("application/json");
  });

  it("always sends Accept: application/json", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    await makeClient().listAgents();
    expect(lastCapture?.headers.accept).toBe("application/json");
  });

  it("sends X-Steward-Key header when apiKey is set", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const client = makeClient({ apiKey: "my-secret-key" });
    await client.listAgents();
    expect(lastCapture?.headers["x-steward-key"]).toBe("my-secret-key");
  });

  it("sends Authorization: Bearer header when bearerToken is set", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const client = makeClient({ bearerToken: "my-jwt-token" });
    await client.listAgents();
    expect(lastCapture?.headers.authorization).toBe("Bearer my-jwt-token");
  });

  it("bearerToken takes priority over apiKey when both are set", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const client = makeClient({
      apiKey: "my-api-key",
      bearerToken: "my-bearer",
    });
    await client.listAgents();
    expect(lastCapture?.headers.authorization).toBe("Bearer my-bearer");
    // apiKey should not be sent when bearerToken is present
    expect(lastCapture?.headers["x-steward-key"]).toBeUndefined();
  });

  it("sends X-Steward-Tenant header when tenantId is set", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const client = makeClient({ tenantId: "my-tenant-123" });
    await client.listAgents();
    expect(lastCapture?.headers["x-steward-tenant"]).toBe("my-tenant-123");
  });

  it("does not send auth header when neither apiKey nor bearerToken is set", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    await makeClient().listAgents();
    expect(lastCapture?.headers.authorization).toBeUndefined();
    expect(lastCapture?.headers["x-steward-key"]).toBeUndefined();
  });
});

// ─── HTTP Request Building Tests ──────────────────────────────────────────

describe("HTTP request building", () => {
  it("listAgents → GET /agents", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    await makeClient().listAgents();
    expect(lastCapture?.method).toBe("GET");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents");
  });

  it("getAgent → GET /agents/:id", async () => {
    installMockFetch({ ok: true, data: mockAgent });
    await makeClient().getAgent("agent-1");
    expect(lastCapture?.method).toBe("GET");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/agent-1");
  });

  it("getAgent encodes special characters in agentId", async () => {
    installMockFetch({ ok: true, data: mockAgent });
    await makeClient().getAgent("agent/with spaces");
    expect(lastCapture?.url).toContain(encodeURIComponent("agent/with spaces"));
  });

  it("createWallet → POST /agents with correct body", async () => {
    installMockFetch({ ok: true, data: mockAgent });
    await makeClient().createWallet("agent-1", "Test Agent", "platform-xyz");
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents");
    expect(lastCapture?.body).toEqual({
      id: "agent-1",
      name: "Test Agent",
      platformId: "platform-xyz",
    });
  });

  it("createWallet without platformId sends undefined/omitted field", async () => {
    installMockFetch({ ok: true, data: mockAgent });
    await makeClient().createWallet("agent-1", "Test Agent");
    expect(lastCapture?.body).toEqual({
      id: "agent-1",
      name: "Test Agent",
      platformId: undefined,
    });
  });

  it("signTransaction → POST /vault/:agentId/sign", async () => {
    installMockFetch({ ok: true, data: { txHash: "0xdeadbeef" } });
    const tx: SignTransactionInput = {
      to: "0x1234567890123456789012345678901234567890",
      value: "1000000000000000000",
      chainId: 8453,
    };
    await makeClient().signTransaction("agent-1", tx);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.url).toBe("https://api.steward.example/vault/agent-1/sign");
    expect(lastCapture?.body).toEqual(tx);
  });

  it("getPolicies → GET /agents/:id/policies", async () => {
    installMockFetch({ ok: true, data: [mockPolicy] });
    await makeClient().getPolicies("agent-1");
    expect(lastCapture?.method).toBe("GET");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/agent-1/policies");
  });

  it("setPolicies → PUT /agents/:id/policies", async () => {
    installMockFetch({ ok: true, data: null });
    await makeClient().setPolicies("agent-1", [mockPolicy]);
    expect(lastCapture?.method).toBe("PUT");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/agent-1/policies");
    expect(lastCapture?.body).toEqual([mockPolicy]);
  });

  it("getHistory → GET /vault/:id/history", async () => {
    installMockFetch({ ok: true, data: [] });
    await makeClient().getHistory("agent-1");
    expect(lastCapture?.method).toBe("GET");
    expect(lastCapture?.url).toBe("https://api.steward.example/vault/agent-1/history");
  });

  it("signMessage → POST /vault/:id/sign-message", async () => {
    installMockFetch({ ok: true, data: { signature: "0xsig" } });
    await makeClient().signMessage("agent-1", "hello world");
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.url).toBe("https://api.steward.example/vault/agent-1/sign-message");
    expect(lastCapture?.body).toEqual({ message: "hello world" });
  });

  it("getBalance without chainId → GET /agents/:id/balance (no query param)", async () => {
    installMockFetch({
      ok: true,
      data: {
        agentId: "agent-1",
        walletAddress: "0xabc",
        balances: {
          native: "0",
          nativeFormatted: "0",
          chainId: 8453,
          symbol: "ETH",
        },
      },
    });
    await makeClient().getBalance("agent-1");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/agent-1/balance");
  });

  it("getBalance with chainId → GET /agents/:id/balance?chainId=1", async () => {
    installMockFetch({
      ok: true,
      data: {
        agentId: "agent-1",
        walletAddress: "0xabc",
        balances: {
          native: "0",
          nativeFormatted: "0",
          chainId: 1,
          symbol: "ETH",
        },
      },
    });
    await makeClient().getBalance("agent-1", 1);
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/agent-1/balance?chainId=1");
  });

  it("createWalletBatch → POST /agents/batch", async () => {
    installMockFetch({ ok: true, data: { created: [mockAgent], errors: [] } });
    await makeClient().createWalletBatch([{ id: "a1", name: "Agent 1" }]);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.url).toBe("https://api.steward.example/agents/batch");
    expect((lastCapture?.body as Record<string, unknown>)?.agents).toEqual([
      { id: "a1", name: "Agent 1" },
    ]);
  });
});

// ─── Error Handling Tests ─────────────────────────────────────────────────

describe("Error handling", () => {
  it("throws StewardApiError on non-ok API response", async () => {
    installMockFetch({ ok: false, error: "Agent not found" }, 404);
    const client = makeClient();
    await expect(client.getAgent("missing-agent")).rejects.toThrow(StewardApiError);
  });

  it("StewardApiError carries correct status code", async () => {
    installMockFetch({ ok: false, error: "Unauthorized" }, 401);
    const client = makeClient();
    let caught: StewardApiError | null = null;
    try {
      await client.getAgent("agent-1");
    } catch (e) {
      caught = e as StewardApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(401);
    expect(caught?.message).toBe("Unauthorized");
    expect(caught?.name).toBe("StewardApiError");
  });

  it("StewardApiError carries response data payload", async () => {
    const errorData = {
      results: [{ policyId: "p1", type: "spending-limit", passed: false }],
    };
    installMockFetch({ ok: false, error: "Policy rejected", data: errorData }, 403);
    const client = makeClient();
    let caught: StewardApiError | null = null;
    try {
      await client.signTransaction("agent-1", {
        to: "0x1234567890123456789012345678901234567890",
        value: "1000000000000000000",
      });
    } catch (e) {
      caught = e as StewardApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.data).toEqual(errorData);
  });

  it("throws StewardApiError on network failure (fetch throws)", async () => {
    installNetworkErrorFetch();
    const client = makeClient();
    let caught: StewardApiError | null = null;
    try {
      await client.listAgents();
    } catch (e) {
      caught = e as StewardApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe("StewardApiError");
    expect(caught?.status).toBe(0);
    expect(caught?.message).toContain("Network error");
  });

  it("throws StewardApiError on invalid JSON response", async () => {
    installBadJsonFetch(200);
    const client = makeClient();
    await expect(client.listAgents()).rejects.toThrow(StewardApiError);
  });

  it("createWallet rethrows StewardApiError on 409 Conflict", async () => {
    installMockFetch({ ok: false, error: "Agent already exists" }, 409);
    const client = makeClient();
    let caught: StewardApiError | null = null;
    try {
      await client.createWallet("agent-1", "Duplicate");
    } catch (e) {
      caught = e as StewardApiError;
    }
    expect(caught?.status).toBe(409);
    expect(caught?.message).toContain("already exists");
  });

  it("setPolicies throws on error without returning data", async () => {
    installMockFetch({ ok: false, error: "Forbidden" }, 403);
    const client = makeClient();
    await expect(client.setPolicies("agent-1", [])).rejects.toThrow(StewardApiError);
  });
});

// ─── Response Parsing Tests ───────────────────────────────────────────────

describe("Response parsing", () => {
  it("listAgents returns parsed agent array", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const agents = await makeClient().listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent-1");
    expect(agents[0].name).toBe("Test Agent");
  });

  it("listAgents parses createdAt as Date object", async () => {
    installMockFetch({ ok: true, data: [mockAgent] });
    const agents = await makeClient().listAgents();
    // parseAgentIdentity converts createdAt string to Date
    expect(agents[0].createdAt).toBeInstanceOf(Date);
  });

  it("getAgent returns single agent", async () => {
    installMockFetch({ ok: true, data: mockAgent });
    const agent = await makeClient().getAgent("agent-1");
    expect(agent.id).toBe("agent-1");
    expect(agent.walletAddress).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("getPolicies returns array of PolicyRule", async () => {
    installMockFetch({ ok: true, data: [mockPolicy] });
    const policies = await makeClient().getPolicies("agent-1");
    expect(policies).toHaveLength(1);
    expect(policies[0].id).toBe("rule-1");
    expect(policies[0].type).toBe("spending-limit");
  });

  it("signTransaction returns txHash on success", async () => {
    installMockFetch({ ok: true, data: { txHash: "0xdeadbeef123" } });
    const result = await makeClient().signTransaction("agent-1", {
      to: "0x1234567890123456789012345678901234567890",
      value: "1000000000000000000",
    });
    expect(result).toEqual({ txHash: "0xdeadbeef123" });
  });

  it("signTransaction returns pending_approval when status 202", async () => {
    // The client treats 202 + pending_approval data as a valid result (not an error)
    installMockFetch(
      {
        ok: false,
        error: "Approval required",
        data: {
          status: "pending_approval",
          results: [{ policyId: "p1", type: "auto-approve-threshold", passed: false }],
        },
      },
      202,
    );
    const result = await makeClient().signTransaction("agent-1", {
      to: "0x1234567890123456789012345678901234567890",
      value: "5000000000000000000",
    });
    expect((result as { status: string }).status).toBe("pending_approval");
  });

  it("signMessage returns signature string", async () => {
    const sig =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    installMockFetch({ ok: true, data: { signature: sig } });
    const result = await makeClient().signMessage("agent-1", "test");
    expect(result.signature).toBe(sig);
  });

  it("createWalletBatch returns created and errors arrays", async () => {
    installMockFetch({
      ok: true,
      data: {
        created: [mockAgent],
        errors: [{ id: "agent-bad", error: "Already exists" }],
      },
    });
    const result = await makeClient().createWalletBatch([
      { id: "agent-1", name: "Agent 1" },
      { id: "agent-bad", name: "Bad Agent" },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe("agent-bad");
  });
});

// ─── StewardApiError Class Tests ──────────────────────────────────────────

describe("StewardApiError", () => {
  it("constructs with message, status, and optional data", () => {
    const err = new StewardApiError("Something went wrong", 500, {
      detail: "internal",
    });
    expect(err.message).toBe("Something went wrong");
    expect(err.status).toBe(500);
    expect(err.data).toEqual({ detail: "internal" });
    expect(err.name).toBe("StewardApiError");
  });

  it("constructs without data (undefined)", () => {
    const err = new StewardApiError("Not found", 404);
    expect(err.status).toBe(404);
    expect(err.data).toBeUndefined();
  });

  it("is an instance of Error", () => {
    const err = new StewardApiError("test", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StewardApiError);
  });

  it("status 0 indicates a network-level failure (no HTTP response)", () => {
    const err = new StewardApiError("Network request failed", 0);
    expect(err.status).toBe(0);
  });
});
