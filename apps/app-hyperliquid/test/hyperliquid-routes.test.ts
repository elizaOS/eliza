import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { hyperliquidPlugin } from "../src/plugin";
import { type HyperliquidFetch, handleHyperliquidRoute } from "../src/routes";

const VALID_LOCAL_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const VALID_AGENT_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";

interface CapturedResponse {
  status: number;
  headers: Record<string, number | string | string[]>;
  json: unknown;
}

async function callRoute({
  method = "GET",
  path,
  env = {},
  fetchImpl,
}: {
  method?: string;
  path: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: HyperliquidFetch;
}): Promise<CapturedResponse> {
  const captured: CapturedResponse = {
    status: 200,
    headers: {},
    json: null,
  };
  const req = { url: path, method } as http.IncomingMessage;
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: number | string | string[]) {
      captured.headers[name] = value;
    },
    end(body: string) {
      captured.status = this.statusCode;
      captured.json = JSON.parse(body) as unknown;
    },
  } as http.ServerResponse;

  await handleHyperliquidRoute(req, res, path, method, {
    env,
    fetchImpl,
    now: () => new Date("2026-04-29T12:00:00.000Z"),
  });
  return captured;
}

function responseJson<T>(response: CapturedResponse): T {
  return response.json as T;
}

describe("Hyperliquid routes", () => {
  it("reports public read and execution readiness independently", async () => {
    const response = await callRoute({
      path: "/api/hyperliquid/status",
      env: {
        EVM_PRIVATE_KEY: VALID_LOCAL_KEY,
        HL_ACCOUNT_ADDRESS: "0x0000000000000000000000000000000000000001",
      },
      fetchImpl: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      publicReadReady: true,
      signerReady: true,
      executionReady: false,
      credentialMode: "local_key",
      accountAddress: "0x0000000000000000000000000000000000000001",
      readiness: {
        publicReads: true,
        accountReads: true,
        signer: true,
        execution: false,
      },
      account: {
        address: "0x0000000000000000000000000000000000000001",
        source: "env_account",
      },
    });
    expect(
      responseJson<{ executionBlockedReason: string }>(response)
        .executionBlockedReason,
    ).toContain("not implemented");
  });

  it("does not require registration, a vault, or local keys for public reads", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }],
        }),
        { status: 200 },
      );
    });

    const statusResponse = await callRoute({
      path: "/api/hyperliquid/status",
      fetchImpl,
    });
    const marketsResponse = await callRoute({
      path: "/api/hyperliquid/markets",
      fetchImpl,
    });

    expect(statusResponse.status).toBe(200);
    expect(responseJson<Record<string, unknown>>(statusResponse)).toMatchObject(
      {
        publicReadReady: true,
        signerReady: false,
        executionReady: false,
        credentialMode: "none",
        readiness: {
          publicReads: true,
          accountReads: false,
          signer: false,
          execution: false,
        },
        vault: {
          configured: false,
          ready: false,
          address: null,
        },
        apiWallet: {
          configured: false,
        },
      },
    );
    expect(marketsResponse.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hyperliquid.xyz/info",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "meta" }),
      }),
    );
  });

  it("defaults account readiness to the managed vault when it is available", async () => {
    const response = await callRoute({
      path: "/api/hyperliquid/status",
      env: {
        STEWARD_API_URL: "https://steward.example",
        STEWARD_AGENT_ID: "agent-1",
        STEWARD_EVM_ADDRESS: "0x0000000000000000000000000000000000000002",
        EVM_PRIVATE_KEY: VALID_LOCAL_KEY,
        HL_ACCOUNT_ADDRESS: "0x0000000000000000000000000000000000000001",
      },
      fetchImpl: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      credentialMode: "managed_vault",
      signerReady: true,
      accountAddress: "0x0000000000000000000000000000000000000002",
      account: {
        address: "0x0000000000000000000000000000000000000002",
        source: "managed_vault",
      },
      vault: {
        configured: true,
        ready: true,
        address: "0x0000000000000000000000000000000000000002",
      },
    });
  });

  it("keeps local keys as an advanced optional readiness path", async () => {
    const response = await callRoute({
      path: "/api/hyperliquid/status",
      env: {
        HYPERLIQUID_PRIVATE_KEY: VALID_LOCAL_KEY,
        HYPERLIQUID_AGENT_KEY: VALID_AGENT_KEY,
      },
      fetchImpl: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      publicReadReady: true,
      signerReady: true,
      executionReady: false,
      credentialMode: "local_key",
      accountAddress: null,
      vault: {
        configured: false,
        ready: false,
      },
      apiWallet: {
        configured: true,
      },
    });
    expect(
      responseJson<{ executionBlockedReason: string }>(response)
        .executionBlockedReason,
    ).toContain("not implemented");
  });

  it("does not report malformed local keys as signer readiness", async () => {
    const response = await callRoute({
      path: "/api/hyperliquid/status",
      env: {
        HYPERLIQUID_PRIVATE_KEY: "0xabc",
        HYPERLIQUID_AGENT_KEY: "0xdef",
      },
      fetchImpl: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      publicReadReady: true,
      signerReady: false,
      executionReady: false,
      credentialMode: "none",
      apiWallet: {
        configured: false,
      },
    });
  });

  it("fetches markets from the Hyperliquid Info endpoint through injected fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          universe: [
            {
              name: "BTC",
              szDecimals: 5,
              maxLeverage: 50,
              onlyIsolated: false,
            },
            {
              name: "ETH",
              szDecimals: 4,
              maxLeverage: 25,
              isDelisted: false,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const response = await callRoute({
      path: "/api/hyperliquid/markets",
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hyperliquid.xyz/info",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "meta" }),
      }),
    );
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      source: "hyperliquid-info-meta",
      fetchedAt: "2026-04-29T12:00:00.000Z",
      markets: [
        {
          name: "BTC",
          index: 0,
          szDecimals: 5,
          maxLeverage: 50,
          onlyIsolated: false,
          isDelisted: false,
        },
        {
          name: "ETH",
          index: 1,
          szDecimals: 4,
          maxLeverage: 25,
          onlyIsolated: false,
          isDelisted: false,
        },
      ],
    });
  });

  it("does not invent account positions when no account address is configured", async () => {
    const fetchImpl = vi.fn();
    const response = await callRoute({
      path: "/api/hyperliquid/positions",
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      accountAddress: null,
      positions: [],
      fetchedAt: null,
    });
    expect(
      responseJson<{ readBlockedReason: string }>(response).readBlockedReason,
    ).toContain("HYPERLIQUID_ACCOUNT_ADDRESS");
  });

  it("returns explicit 501 for unimplemented mutation attempts", async () => {
    const response = await callRoute({
      method: "POST",
      path: "/api/hyperliquid/orders",
    });

    expect(response.status).toBe(501);
    expect(responseJson<Record<string, unknown>>(response)).toMatchObject({
      executionReady: false,
      credentialMode: "none",
    });
  });

  it("registers only the read/status plugin routes", () => {
    const paths = (hyperliquidPlugin.routes ?? []).map((route) => [
      route.type,
      route.path,
    ]);

    expect(paths).toEqual([
      ["GET", "/api/hyperliquid/status"],
      ["GET", "/api/hyperliquid/markets"],
      ["GET", "/api/hyperliquid/positions"],
      ["GET", "/api/hyperliquid/orders"],
      ["POST", "/api/hyperliquid/orders/open"],
      ["POST", "/api/hyperliquid/orders/close"],
      ["POST", "/api/hyperliquid/leverage"],
      ["POST", "/api/hyperliquid/margin"],
      ["POST", "/api/hyperliquid/bridge"],
      ["POST", "/api/hyperliquid/tpsl"],
    ]);
  });
});
