/**
 * Shared harness for the CLOUD_ACCOUNT provider/action suites: a REAL loopback
 * HTTP server standing in for the Eliza Cloud API (the SDK, its URL building,
 * auth headers, and error mapping all run for real — nothing under test is
 * mocked) plus a minimal runtime fake exposing only the seams the code reads
 * (getSetting for the base URL/key, getService("CLOUD_AUTH") for the
 * signed-in gate).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";

export interface CloudServerState {
  balance: number;
  agents: Array<{ id: string; agentName: string | null; status: string }>;
  /** When true, GET /credits/balance returns 500. */
  failBalance: boolean;
  /** When true, GET /eliza/agents returns 500. */
  failAgents: boolean;
  /** HTTP status for POST /api-keys (200 = created). */
  createKeyStatus: number;
  /** Every request path seen, in order. */
  requests: string[];
  /** Body of the last POST /api-keys request. */
  lastCreateKeyBody: Record<string, unknown> | null;
}

export interface CloudServer {
  state: CloudServerState;
  url: string;
  close: () => Promise<void>;
}

export async function startCloudServer(): Promise<CloudServer> {
  const state: CloudServerState = {
    balance: 12.34,
    agents: [
      { id: "agent-1", agentName: "alpha", status: "running" },
      { id: "agent-2", agentName: "beta", status: "stopped" },
    ],
    failBalance: false,
    failAgents: false,
    createKeyStatus: 200,
    requests: [],
    lastCreateKeyBody: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.requests.push(`${req.method} ${url.pathname}`);

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/api/v1/credits/balance") {
      if (state.failBalance) return json(500, { success: false, error: "boom" });
      return json(200, { balance: state.balance });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/eliza/agents") {
      if (state.failAgents) return json(500, { success: false, error: "boom" });
      return json(200, { success: true, data: state.agents });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/api-keys") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        state.lastCreateKeyBody = JSON.parse(raw) as Record<string, unknown>;
        if (state.createKeyStatus !== 200) {
          return json(state.createKeyStatus, {
            success: false,
            error: "Session required",
          });
        }
        const name = String(state.lastCreateKeyBody?.name ?? "unnamed");
        return json(200, {
          apiKey: {
            id: "key-1",
            name,
            key_prefix: "eliza_abc1",
            created_at: "2026-07-06T00:00:00.000Z",
          },
          plainKey: "eliza_plain_key_shown_once",
        });
      });
      return;
    }
    json(404, { success: false, error: `no route for ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function makeRuntime(options: { baseUrl: string; authenticated?: boolean }): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_BASE_URL: `${options.baseUrl}/api/v1`,
    ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  };
  const auth = {
    isAuthenticated: () => options.authenticated !== false,
    getOrganizationId: () => "org-test",
    getUserId: () => "user-test",
  };
  return {
    getSetting: (key: string) => settings[key],
    getService: (type: string) => (type === "CLOUD_AUTH" ? auth : null),
  } as unknown as IAgentRuntime;
}
