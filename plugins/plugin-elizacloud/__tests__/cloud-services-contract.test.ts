/**
 * Deterministic contract tests for the cloud services' HTTP layer.
 *
 * CloudAuthService and CloudContainerService both use CloudApiClient, which
 * calls real `fetch`; a loopback HTTP double returns
 * controlled responses so the client-side code paths run for real.
 *
 * This is NOT live-cloud coverage. It was formerly misnamed
 * `cloud-services.real.test.ts`, which parked a stub-backed test in the
 * live-API `*.real.test.ts` lane. Live coverage lives in the post-merge real lane (`TEST_LANE=post-merge`).
 */

import * as http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloudContainer } from "../src/types/cloud";
import { CloudApiClient } from "../src/utils/cloud-api";

// ─── Test server ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

type RouteHandler = (
  req: http.IncomingMessage,
  body: string
) => { status: number; body: Record<string, unknown> };
const routes: Map<string, RouteHandler> = new Map();

function route(method: string, path: string, handler: RouteHandler): void {
  routes.set(`${method} ${path}`, handler);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const key = `${req.method} ${req.url?.split("?")[0]}`;
      const handler = routes.get(key);
      if (handler) {
        const result = handler(req, body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: `No route: ${key}` }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  routes.clear();
});

// ─── CloudApiClient integration with route handlers ──────────────────────

describe("CloudApiClient with route-based server", () => {
  it("GET /containers returns list", async () => {
    const containers: Partial<CloudContainer>[] = [
      { id: "c1", name: "agent-1", status: "running" },
      { id: "c2", name: "agent-2", status: "stopped" },
    ];
    route("GET", "/containers", () => ({
      status: 200,
      body: { success: true, data: containers },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.requestData<{ data: typeof containers }>("GET", "/containers");
    expect(result.data).toHaveLength(2);
    expect(result.data[0].name).toBe("agent-1");
    expect(result.data[1].status).toBe("stopped");
  });

  it("POST /containers creates and returns 202", async () => {
    route("POST", "/containers", (_req, body) => {
      const parsed = JSON.parse(body);
      return {
        status: 202,
        body: {
          success: true,
          data: { id: "new-c", name: parsed.name, status: "pending" },
          creditsDeducted: 10,
          creditsRemaining: 90,
          stackName: "stack-new-c",
          polling: {
            endpoint: "/containers/new-c",
            intervalMs: 10000,
            expectedDurationMs: 600000,
          },
        },
      };
    });

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.post<Record<string, unknown>>("/containers", {
      name: "my-agent",
      project_name: "proj",
    });
    expect((result as { data: { id: string } }).data.id).toBe("new-c");
    expect(result.creditsDeducted).toBe(10);
  });

  it("DELETE /containers/:id returns success", async () => {
    route("DELETE", "/containers/abc", () => ({
      status: 200,
      body: { success: true },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.delete<{ success: boolean }>("/containers/abc");
    expect(result.success).toBe(true);
  });

  it("GET /credits/balance returns numeric balance", async () => {
    route("GET", "/credits/balance", () => ({
      status: 200,
      body: { success: true, data: { balance: 4.37, currency: "USD" } },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.requestData<{ data: { balance: number } }>(
      "GET",
      "/credits/balance"
    );
    expect(result.data.balance).toBeCloseTo(4.37);
  });
});

// ─── Container status polling simulation ─────────────────────────────────

describe("container deployment polling simulation", () => {
  it("transitions through pending → building → deploying → running", async () => {
    let callCount = 0;
    const statuses = ["pending", "building", "deploying", "running"];

    route("GET", "/containers/poll-test", () => {
      const status = statuses[Math.min(callCount, statuses.length - 1)];
      callCount++;
      return {
        status: 200,
        body: {
          success: true,
          data: {
            id: "poll-test",
            status,
            load_balancer_url: status === "running" ? "http://lb.example.com" : null,
          },
        },
      };
    });

    const client = new CloudApiClient(baseUrl, "eliza_test");

    // Simulate the polling loop from CloudContainerService.waitForDeployment
    let interval = 100; // Sped up for test
    const deadline = Date.now() + 5000;
    let finalContainer: Record<string, unknown> | null = null;

    while (Date.now() < deadline) {
      const result = await client.get<{
        data: { status: string; load_balancer_url: string | null };
      }>("/containers/poll-test");
      if (result.data.status === "running") {
        finalContainer = result.data;
        break;
      }
      if (result.data.status === "failed") throw new Error("Unexpected failure");
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 1.5, 500);
    }

    expect(finalContainer === null).toBe(false);
    expect(finalContainer?.status).toBe("running");
    expect(finalContainer?.load_balancer_url).toBe("http://lb.example.com");
    expect(callCount).toBe(4); // pending, building, deploying, running
  });

  it("detects failed deployment", async () => {
    route("GET", "/containers/fail-test", () => ({
      status: 200,
      body: {
        success: true,
        data: {
          id: "fail-test",
          status: "failed",
          error_message: "Stack rolled back",
        },
      },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.get<{
      data: { status: string; error_message: string };
    }>("/containers/fail-test");
    expect(result.data.status).toBe("failed");
    expect(result.data.error_message).toBe("Stack rolled back");
  });
});

// ─── Credit lifecycle simulation ─────────────────────────────────────────

describe("credit lifecycle", () => {
  it("balance check → insufficient credits on container create", async () => {
    route("GET", "/credits/balance", () => ({
      status: 200,
      body: { success: true, data: { balance: 2.0, currency: "USD" } },
    }));

    route("POST", "/containers", () => ({
      status: 402,
      body: {
        success: false,
        error: "Insufficient balance. Required: $10.00",
        requiredCredits: 10.0,
      },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");

    // Check balance first
    const balance = await client.requestData<{ data: { balance: number } }>(
      "GET",
      "/credits/balance"
    );
    expect(balance.data.balance).toBe(2.0);

    // Attempt container creation — should throw InsufficientCreditsError
    let caught: Error | null = null;
    await client.post("/containers", { name: "x" }).catch((e: Error) => {
      caught = e;
    });

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("Insufficient balance");
  });
});

// ─── Concurrent requests ─────────────────────────────────────────────────

describe("concurrent requests", () => {
  it("handles multiple simultaneous requests without interference", async () => {
    let requestCount = 0;
    route("GET", "/slow", () => {
      requestCount++;
      return { status: 200, body: { success: true, n: requestCount } };
    });

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const results = await Promise.all([
      client.requestData<{ n: number }>("GET", "/slow"),
      client.requestData<{ n: number }>("GET", "/slow"),
      client.requestData<{ n: number }>("GET", "/slow"),
    ]);

    expect(results).toHaveLength(3);
    // Each request should have gotten a distinct response
    const numbers = results.map((r) => r.n);
    expect(new Set(numbers).size).toBe(3);
  });
});
