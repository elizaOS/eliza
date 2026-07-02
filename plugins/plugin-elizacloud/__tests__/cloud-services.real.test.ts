/**
 * Tests for cloud services using a real local HTTP server.
 *
 * CloudAuthService, CloudContainerService, and CloudBackupService all
 * use CloudApiClient which calls real `fetch`. We spin up a local server
 * that returns controlled responses so we test real code paths.
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
    const result = await client.get<{ data: typeof containers }>("/containers");
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
    const result = await client.get<{ data: { balance: number } }>("/credits/balance");
    expect(result.data.balance).toBeCloseTo(4.37);
  });

  it("POST /device-auth unauthenticated creates new user", async () => {
    let receivedAuth: string | undefined;
    route("POST", "/device-auth", (req, body) => {
      receivedAuth = req.headers.authorization;
      const _parsed = JSON.parse(body);
      return {
        status: 201,
        body: {
          success: true,
          data: {
            apiKey: "eliza_newkey",
            userId: "user-1",
            organizationId: "org-1",
            credits: 5.0,
            isNew: true,
          },
        },
      };
    });

    const client = new CloudApiClient(baseUrl, "eliza_existing_key");
    const result = await client.postUnauthenticated<{
      data: { apiKey: string; isNew: boolean };
    }>("/device-auth", { deviceId: "abc", platform: "macos" });
    // Verify NO auth header was sent (even though client has a key)
    expect(receivedAuth).toBeUndefined();
    expect(result.data.apiKey).toBe("eliza_newkey");
    expect(result.data.isNew).toBe(true);
  });

  it("POST /agent-state/:id/snapshot creates snapshot", async () => {
    route("POST", "/agent-state/c1/snapshot", () => ({
      status: 200,
      body: {
        success: true,
        data: {
          id: "snap-1",
          containerId: "c1",
          snapshotType: "manual",
          storageUrl: "https://blob.example.com/snap-1.json",
          sizeBytes: 4096,
          created_at: "2026-02-05T00:00:00Z",
        },
      },
    }));

    const client = new CloudApiClient(baseUrl, "eliza_test");
    const result = await client.post<{
      data: { id: string; sizeBytes: number };
    }>("/agent-state/c1/snapshot", { snapshotType: "manual" });
    expect(result.data.id).toBe("snap-1");
    expect(result.data.sizeBytes).toBe(4096);
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
    const balance = await client.get<{ data: { balance: number } }>("/credits/balance");
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

// ─── Snapshot lifecycle simulation ───────────────────────────────────────

describe("snapshot lifecycle", () => {
  it("create → list → restore → delete", async () => {
    const snapshots: Array<{ id: string; snapshotType: string }> = [];

    route("POST", "/agent-state/c1/snapshot", (_req, body) => {
      const parsed = JSON.parse(body);
      const snap = {
        id: `snap-${snapshots.length + 1}`,
        snapshotType: parsed.snapshotType,
      };
      snapshots.push(snap);
      return {
        status: 200,
        body: { success: true, data: { ...snap, sizeBytes: 1024 } },
      };
    });

    route("GET", "/agent-state/c1/snapshots", () => ({
      status: 200,
      body: { success: true, data: [...snapshots] },
    }));

    route("POST", "/agent-state/c1/restore", () => ({
      status: 200,
      body: { success: true, message: "Restored" },
    }));

    route("DELETE", "/agent-state/c1/snapshots/snap-1", () => {
      const idx = snapshots.findIndex((s) => s.id === "snap-1");
      if (idx >= 0) snapshots.splice(idx, 1);
      return { status: 200, body: { success: true } };
    });

    const client = new CloudApiClient(baseUrl, "eliza_test");

    // Create two snapshots
    await client.post("/agent-state/c1/snapshot", { snapshotType: "manual" });
    await client.post("/agent-state/c1/snapshot", { snapshotType: "auto" });
    expect(snapshots).toHaveLength(2);

    // List
    const listed = await client.get<{ data: typeof snapshots }>("/agent-state/c1/snapshots");
    expect(listed.data).toHaveLength(2);

    // Restore
    const restored = await client.post<{ message: string }>("/agent-state/c1/restore", {
      snapshotId: "snap-1",
    });
    expect(restored.message).toBe("Restored");

    // Delete
    await client.delete("/agent-state/c1/snapshots/snap-1");
    const afterDelete = await client.get<{ data: typeof snapshots }>("/agent-state/c1/snapshots");
    expect(afterDelete.data).toHaveLength(1);
    expect(afterDelete.data[0].id).toBe("snap-2");
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
      client.get<{ n: number }>("/slow"),
      client.get<{ n: number }>("/slow"),
      client.get<{ n: number }>("/slow"),
    ]);

    expect(results).toHaveLength(3);
    // Each request should have gotten a distinct response
    const numbers = results.map((r) => r.n);
    expect(new Set(numbers).size).toBe(3);
  });
});
