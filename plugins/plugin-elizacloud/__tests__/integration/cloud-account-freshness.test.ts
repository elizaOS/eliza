/**
 * CLOUD_ACCOUNT snapshot freshness against account changes: hosted-agent
 * create/shutdown through the real cloud routes, and a sign-in to another
 * organization on the same runtime. The SDK talks to a real loopback cloud
 * server; the route's cloud client is a stand-in for the upstream calls.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudAccountProvider } from "../../src/cloud-providers/cloud-account";
import { creditBalanceProvider } from "../../src/cloud-providers/credit-balance";
import { handleCloudRoute } from "../../src/routes/cloud-routes-autonomous";
import { type CloudServer, makeRuntime, startCloudServer } from "./cloud-account-harness";

const MESSAGE = {} as Memory;
const STATE = {} as State;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

let server: CloudServer;

beforeEach(async () => {
  server = await startCloudServer();
});

afterEach(async () => {
  await server.close();
});

async function callRoute(
  runtime: ReturnType<typeof makeRuntime>,
  method: string,
  pathname: string,
  body: unknown
): Promise<number> {
  const client = {
    createAgent: async () => ({ id: AGENT_ID }),
    deleteAgent: async () => undefined,
  };
  const routeServer = http.createServer((req, res) => {
    void handleCloudRoute(req, res, pathname, method, {
      config: {},
      runtime,
      cloudManager: {
        getClient: () => client,
        getActiveAgentId: () => null,
      },
    } as never);
  });
  await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const { port } = routeServer.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.status;
  } finally {
    await new Promise<void>((resolve) => routeServer.close(() => resolve()));
  }
}

describe("CLOUD_ACCOUNT freshness", () => {
  it("refetches after a hosted agent is created or shut down through the routes", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    expect((await cloudAccountProvider.get(runtime, MESSAGE, STATE)).text).toContain(
      "2 hosted agents"
    );

    server.state.agents.push({ id: AGENT_ID, agentName: "gamma", status: "running" });
    expect(await callRoute(runtime, "POST", "/api/cloud/agents", { agentName: "gamma" })).toBe(201);
    const afterCreate = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(afterCreate.text).toContain("3 hosted agents");
    expect(afterCreate.text).toContain("- gamma (running)");

    server.state.agents = server.state.agents.filter((agent) => agent.id !== AGENT_ID);
    expect(await callRoute(runtime, "POST", `/api/cloud/agents/${AGENT_ID}/shutdown`, {})).toBe(
      200
    );
    const afterShutdown = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(afterShutdown.text).toContain("2 hosted agents");
    expect(afterShutdown.text).not.toContain("gamma");
  });

  it("never renders another organization's snapshot after an account switch", async () => {
    let organizationId = "org-first";
    const runtime = makeRuntime({ baseUrl: server.url, organizationId: () => organizationId });
    expect((await cloudAccountProvider.get(runtime, MESSAGE, STATE)).text).toContain("$12.34");

    organizationId = "org-second";
    server.state.balance = 3.5;
    server.state.agents = [];

    const credits = await creditBalanceProvider.get(runtime, MESSAGE, STATE);
    // The harness auth has no direct client, so the credits provider's own
    // fetch reports unavailable; what matters is the old org's $12.34 is gone.
    expect(credits.text).not.toContain("12.34");
    const account = await cloudAccountProvider.get(runtime, MESSAGE, STATE);
    expect(account.text).toContain("(org org-second): $3.50");
    expect(account.text).toContain("Hosted agents: none yet.");
  });
});
