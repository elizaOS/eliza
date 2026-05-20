/**
 * Fidelity tests for control-plane mock — closes the 6 gaps vs the real impl
 * in `packages/cloud-services/container-control-plane/src/index.ts`:
 *
 *   1. POST /api/v1/eliza/agents/:id/stream with JSON-RPC body (SSE response)
 *   2. Dual-token auth (bearer + x-container-control-plane-token)
 *   3. GET variants of all cron endpoints
 *   4. DELETE /api/compat/agents/:id with cascading delete job
 *   5. GET /api/v1/admin/warm-pool + /rollout-status
 *   6. ?limit=N support on /cron/process-provisioning-jobs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type RunningControlPlaneMock,
  startControlPlaneMock,
} from "../src/control-plane";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

process.env.MOCK_HETZNER_LATENCY = "0";

const TOKEN = "fidelity-token";
const ADMIN_TOKEN = "fidelity-admin-token";
const AUX_TOKEN = "fidelity-aux-token";

let hetzner: RunningHetznerMock;
let dual: RunningControlPlaneMock;
let single: RunningControlPlaneMock;

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 5 });
  // Server with dual-token auth enabled.
  dual = await startControlPlaneMock({
    token: TOKEN,
    adminToken: ADMIN_TOKEN,
    expectedAuxToken: AUX_TOKEN,
    hetznerUrl: hetzner.url,
    hetznerToken: "h",
    bridgeStreamIntervalMs: 1,
    warmPoolEnabled: true,
    warmPoolMin: 1,
    warmPoolMax: 5,
    warmPoolImage: "elizaos/agent:fidelity",
  });
  // Server without aux token requirement (for cron-GET + DELETE + limit tests).
  single = await startControlPlaneMock({
    token: TOKEN,
    adminToken: ADMIN_TOKEN,
    expectedAuxToken: "",
    hetznerUrl: hetzner.url,
    hetznerToken: "h",
    bridgeStreamIntervalMs: 1,
  });
});

afterAll(async () => {
  await dual.stop();
  await single.stop();
  await hetzner.stop();
});

function fetchOn(
  server: RunningControlPlaneMock,
  path: string,
  init: RequestInit = {},
  opts: {
    auth?: "user" | "admin" | "none";
    org?: boolean;
    aux?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  const authMode = opts.auth ?? "user";
  if (authMode === "user") headers.authorization = `Bearer ${TOKEN}`;
  else if (authMode === "admin")
    headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  if (opts.org !== false) {
    headers["x-eliza-user-id"] = "user-1";
    headers["x-eliza-organization-id"] = "org-1";
  }
  if (opts.aux !== null && opts.aux !== undefined) {
    headers["x-container-control-plane-token"] = opts.aux;
  }
  return fetch(`${server.url}${path}`, { ...init, headers });
}

describe("Gap 1: POST /agents/:id/stream JSON-RPC bridge", () => {
  test("valid JSON-RPC message.send → SSE with progress + response events", async () => {
    const res = await fetchOn(single, "/api/v1/eliza/agents/a-1/stream", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "message.send",
        params: { text: "hi" },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain("event: response");
    expect(text).toContain('"id":42');
    expect(text).toContain('"jsonrpc":"2.0"');
  });

  test("missing jsonrpc field → 400 with SSE-shaped error", async () => {
    const res = await fetchOn(single, "/api/v1/eliza/agents/a-1/stream", {
      method: "POST",
      body: JSON.stringify({ method: "message.send" }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("event: error");
  });
});

describe("Gap 2: Dual-token auth", () => {
  test("aux token required when expectedAuxToken set: bearer only → 401", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/cron/deployment-monitor",
      { method: "POST" },
      { aux: null },
    );
    expect(res.status).toBe(401);
  });

  test("wrong aux token → 401", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/cron/deployment-monitor",
      { method: "POST" },
      { aux: "wrong" },
    );
    expect(res.status).toBe(401);
  });

  test("bearer + matching aux → 200", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/cron/deployment-monitor",
      { method: "POST" },
      { aux: AUX_TOKEN },
    );
    expect(res.ok).toBe(true);
  });

  test("internal cron accepts matching aux without bearer", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/cron/deployment-monitor",
      { method: "POST" },
      { auth: "none", aux: AUX_TOKEN },
    );
    expect(res.ok).toBe(true);
  });

  test("when expectedAuxToken unset (single server), no aux header needed → 200", async () => {
    const res = await fetchOn(
      single,
      "/api/v1/cron/deployment-monitor",
      { method: "POST" },
      { aux: null },
    );
    expect(res.ok).toBe(true);
  });
});

describe("Gap 3: GET variants of all crons", () => {
  const crons = [
    "/api/v1/cron/deployment-monitor",
    "/api/v1/cron/agent-hot-pool",
    "/api/v1/cron/node-autoscale",
    "/api/v1/cron/pool-replenish",
    "/api/v1/cron/pool-drain-idle",
    "/api/v1/cron/process-provisioning-jobs",
    "/api/v1/cron/cleanup-stuck-provisioning",
  ];
  for (const path of crons) {
    test(`GET ${path} → 200`, async () => {
      const res = await fetchOn(single, path);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        success: boolean;
        data: Record<string, unknown>;
      };
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });
  }
});

describe("Gap 4: DELETE /api/compat/agents/:id", () => {
  test("creates delete job for known agent", async () => {
    // First seed a sandbox via /jobs (POST agent_provision) with an agentId.
    const provisionRes = await fetchOn(single, "/jobs", {
      method: "POST",
      body: JSON.stringify({
        type: "agent_provision",
        agent_id: "agent-del-1",
      }),
    });
    expect(provisionRes.status).toBe(201);

    const delRes = await fetchOn(single, "/api/compat/agents/agent-del-1", {
      method: "DELETE",
    });
    expect(delRes.ok).toBe(true);
    const body = (await delRes.json()) as { ok: boolean; jobId: string };
    expect(body.ok).toBe(true);
    expect(body.jobId).toMatch(/^job-/);
  });

  test("unknown agent → 404 with error agent_not_found", async () => {
    const res = await fetchOn(single, "/api/compat/agents/nonexistent-xyz", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_found");
  });
});

describe("Gap 5: Admin warm-pool GET endpoints", () => {
  test("GET /api/v1/admin/warm-pool returns state snapshot", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/admin/warm-pool",
      {},
      { auth: "admin", org: false, aux: null },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      data: {
        image: string;
        enabled: boolean;
        minSize: number;
        maxSize: number;
        currentSize: number;
        rolloutState: string;
      };
    };
    expect(body.data.image).toBe("elizaos/agent:fidelity");
    expect(body.data.enabled).toBe(true);
    expect(body.data.minSize).toBe(1);
    expect(body.data.maxSize).toBe(5);
    expect(typeof body.data.currentSize).toBe("number");
    expect(body.data.rolloutState).toBe("idle");
  });

  test("GET /api/v1/admin/warm-pool/rollout-status returns rollout info", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/admin/warm-pool/rollout-status",
      {},
      { auth: "admin", org: false, aux: null },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      data: {
        status: string;
        targetImage: string;
        completedSandboxes: number;
        totalSandboxes: number;
      };
    };
    expect(["idle", "in-progress", "complete"]).toContain(body.data.status);
    expect(body.data.targetImage).toBe("elizaos/agent:fidelity");
    expect(typeof body.data.completedSandboxes).toBe("number");
    expect(typeof body.data.totalSandboxes).toBe("number");
  });

  test("warm-pool admin GET requires admin token", async () => {
    const res = await fetchOn(
      dual,
      "/api/v1/admin/warm-pool",
      {},
      { auth: "user", org: false, aux: null },
    );
    expect(res.status).toBe(401);
  });
});

describe("Gap 6: ?limit=N on /cron/process-provisioning-jobs", () => {
  test("limit caps how many jobs process per tick", async () => {
    // Seed 3 provision jobs.
    for (let i = 0; i < 3; i += 1) {
      const res = await fetchOn(single, "/jobs", {
        method: "POST",
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(res.status).toBe(201);
    }
    const tickRes = await fetchOn(
      single,
      "/api/v1/cron/process-provisioning-jobs?limit=2",
      { method: "POST" },
    );
    expect(tickRes.ok).toBe(true);
    const body = (await tickRes.json()) as {
      data: { processed: number; failed: number; skipped: number };
    };
    // At most 2 processed (the rest stay pending → skipped >= 1).
    expect(body.data.processed + body.data.failed).toBeLessThanOrEqual(2);
    expect(body.data.skipped).toBeGreaterThanOrEqual(1);
  });
});
