/** Covers the control plane extended cloud mock with deterministic in-process state and real HTTP handlers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type RunningControlPlaneMock,
  startControlPlaneMock,
} from "../src/control-plane";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

process.env.MOCK_HETZNER_LATENCY = "0";

const TOKEN = "test-token";
const ADMIN_TOKEN = "test-admin-token";

let hetzner: RunningHetznerMock;
let controlPlane: RunningControlPlaneMock;

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 10 });
  controlPlane = await startControlPlaneMock({
    token: TOKEN,
    adminToken: ADMIN_TOKEN,
    hetznerUrl: hetzner.url,
    hetznerToken: "hetzner-test-token",
    hotPoolSize: 0,
    containerActionMs: 30,
    bridgeStreamIntervalMs: 1,
    containerLogLines: ["alpha", "beta", "gamma"],
  });
});

afterAll(async () => {
  await controlPlane.stop();
  await hetzner.stop();
});

function cpFetch(
  path: string,
  init: RequestInit = {},
  opts: { auth?: "user" | "admin" | "none"; org?: boolean } = {},
) {
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
  return fetch(`${controlPlane.url}${path}`, { ...init, headers });
}

async function pollContainer(
  id: string,
  predicate: (status: string | null) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await cpFetch(`/api/v1/containers/${id}`);
    if (res.status === 404) {
      if (predicate(null)) return null;
    } else {
      const body = (await res.json()) as { data?: { status: string } };
      if (body.data && predicate(body.data.status)) return body.data;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`container ${id} never reached desired state`);
}

describe("control-plane mock — containers CRUD", () => {
  test("create → get → patch env → patch scale → restart → delete", async () => {
    const createRes = await cpFetch("/api/v1/containers", {
      method: "POST",
      body: JSON.stringify({
        name: "agent-1",
        project_name: "proj-1",
        image: "elizaos/agent:latest",
        port: 4000,
        desired_count: 2,
        environment_vars: { FOO: "bar" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      data: { id: string; status: string };
    };
    expect(created.data.status).toBe("pending");
    const id = created.data.id;

    const running = await pollContainer(id, (s) => s === "running");
    expect(running!.status).toBe("running");

    const patchEnvRes = await cpFetch(`/api/v1/containers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ environment_vars: { FOO: "baz", NEW: "v" } }),
    });
    expect(patchEnvRes.ok).toBe(true);
    const envBody = (await patchEnvRes.json()) as {
      data: { environmentVars: Record<string, string> };
    };
    expect(envBody.data.environmentVars).toEqual({ FOO: "baz", NEW: "v" });

    const patchScaleRes = await cpFetch(`/api/v1/containers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ desired_count: 5 }),
    });
    expect(patchScaleRes.ok).toBe(true);

    const restartRes = await cpFetch(`/api/v1/containers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "restart" }),
    });
    const restartBody = (await restartRes.json()) as {
      data: { status: string };
    };
    expect(restartBody.data.status).toBe("restarting");
    await pollContainer(id, (s) => s === "running");

    const deleteRes = await cpFetch(`/api/v1/containers/${id}`, {
      method: "DELETE",
    });
    expect(deleteRes.ok).toBe(true);
    await pollContainer(id, (s) => s === null);
  });

  test("workspace-sync, logs, metrics", async () => {
    const createRes = await cpFetch("/api/v1/containers", {
      method: "POST",
      body: JSON.stringify({
        name: "agent-2",
        project_name: "p",
        image: "img",
      }),
    });
    const { data } = (await createRes.json()) as { data: { id: string } };
    const id = data.id;
    await pollContainer(id, (s) => s === "running");

    const syncRes = await cpFetch(`/api/v1/containers/${id}/workspace-sync`, {
      method: "POST",
      body: JSON.stringify({ direction: "push", changedFiles: [] }),
    });
    expect(syncRes.status).toBe(202);
    const syncBody = (await syncRes.json()) as { data: { syncCount: number } };
    expect(syncBody.data.syncCount).toBe(1);

    const logsRes = await cpFetch(`/api/v1/containers/${id}/logs?tail=2`);
    expect(logsRes.ok).toBe(true);
    const logs = await logsRes.text();
    expect(logs).toContain("beta");
    expect(logs).toContain("gamma");

    const metricsRes = await cpFetch(`/api/v1/containers/${id}/metrics`);
    expect(metricsRes.ok).toBe(true);
    const metrics = (await metricsRes.json()) as {
      data: { cpu: { usagePct: number }; memory: { usedMb: number } };
    };
    expect(metrics.data.cpu.usagePct).toBeGreaterThan(0);
    expect(metrics.data.memory.usedMb).toBeGreaterThan(0);
  });

  test("GET unknown container → 404", async () => {
    const res = await cpFetch("/api/v1/containers/nope");
    expect(res.status).toBe(404);
  });
});

describe("control-plane mock — JSON-RPC bridge", () => {
  test("ping → pong", async () => {
    const res = await cpFetch("/api/v1/eliza/agents/a-1/bridge", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { pong: boolean };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.pong).toBe(true);
  });

  test("getStatus → running", async () => {
    const res = await cpFetch("/api/v1/eliza/agents/a-1/bridge", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getStatus" }),
    });
    const body = (await res.json()) as { result: { status: string } };
    expect(body.result.status).toBe("running");
  });

  test("unknown method → empty result", async () => {
    const res = await cpFetch("/api/v1/eliza/agents/a-1/bridge", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "weird" }),
    });
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).toEqual({});
  });

  test("malformed → 400", async () => {
    const res = await cpFetch("/api/v1/eliza/agents/a-1/bridge", {
      method: "POST",
      body: JSON.stringify({ not: "rpc" }),
    });
    expect(res.status).toBe(400);
  });

  test("SSE stream emits ready, 3 ticks, done", async () => {
    const res = await cpFetch("/api/v1/eliza/agents/a-1/bridge/stream");
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: ready");
    expect(text).toContain("event: tick");
    expect(text).toContain("event: done");
    // 3 tick events
    const tickCount = (text.match(/event: tick/g) ?? []).length;
    expect(tickCount).toBe(3);
  });
});

describe("control-plane mock — hot-pool and autoscale crons", () => {
  test("agent-hot-pool with target=2 produces 2 warm sandboxes", async () => {
    // Bump target via admin endpoint.
    const adminRes = await cpFetch(
      "/api/v1/admin/warm-pool",
      { method: "POST", body: JSON.stringify({ target: 2 }) },
      { auth: "admin", org: false },
    );
    expect(adminRes.ok).toBe(true);

    const tickRes = await cpFetch("/api/v1/cron/agent-hot-pool", {
      method: "POST",
    });
    expect(tickRes.ok).toBe(true);
    const body = (await tickRes.json()) as {
      data: { added: number; warmPoolSize: number; target: number };
    };
    expect(body.data.target).toBe(2);
    expect(body.data.warmPoolSize).toBe(2);
    // Idempotent — second tick adds zero.
    const second = (await (
      await cpFetch("/api/v1/cron/agent-hot-pool", { method: "POST" })
    ).json()) as { data: { added: number; warmPoolSize: number } };
    expect(second.data.added).toBe(0);
    expect(second.data.warmPoolSize).toBe(2);
  });

  test("deployment-monitor increments counter", async () => {
    const a = (await (
      await cpFetch("/api/v1/cron/deployment-monitor", { method: "POST" })
    ).json()) as { data: { count: number } };
    const b = (await (
      await cpFetch("/api/v1/cron/deployment-monitor", { method: "POST" })
    ).json()) as { data: { count: number } };
    expect(b.data.count).toBe(a.data.count + 1);
  });

  test("node-autoscale → noop success", async () => {
    const res = await cpFetch("/api/v1/cron/node-autoscale", {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data: { action: string } };
    expect(body.data.action).toBe("noop");
  });

  test("pool-* wildcard cron", async () => {
    const r1 = await cpFetch("/api/v1/cron/pool-replenish", { method: "POST" });
    expect(r1.ok).toBe(true);
    const r2 = await cpFetch("/api/v1/cron/pool-drain-idle", {
      method: "POST",
    });
    expect(r2.ok).toBe(true);
    const body = (await r2.json()) as { data: { kind: string } };
    expect(body.data.kind).toBe("pool-drain-idle");
  });
});

describe("control-plane mock — admin endpoints", () => {
  test("warm-pool requires admin token", async () => {
    const res = await cpFetch(
      "/api/v1/admin/warm-pool",
      { method: "POST", body: JSON.stringify({ target: 1 }) },
      { auth: "user", org: false },
    );
    expect(res.status).toBe(401);
  });

  test("warm-pool with admin token succeeds", async () => {
    const res = await cpFetch(
      "/api/v1/admin/warm-pool",
      { method: "POST", body: JSON.stringify({ target: 1 }) },
      { auth: "admin", org: false },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data: { target: number } };
    expect(body.data.target).toBe(1);
  });

  test("docker-node health-check returns healthy", async () => {
    const res = await cpFetch(
      "/api/v1/admin/docker-nodes/node-1/health-check",
      { method: "POST" },
      { auth: "admin", org: false },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      data: { healthy: boolean; nodeId: string };
    };
    expect(body.data.healthy).toBe(true);
    expect(body.data.nodeId).toBe("node-1");
  });

  test("docker-node health-check missing admin → 401", async () => {
    const res = await cpFetch(
      "/api/v1/admin/docker-nodes/node-1/health-check",
      { method: "POST" },
      { auth: "none", org: false },
    );
    expect(res.status).toBe(401);
  });
});

describe("control-plane mock — compat", () => {
  test("compat agents returns stub character", async () => {
    const res = await cpFetch(
      "/api/compat/agents/abc-123",
      {},
      { auth: "none", org: false },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data: { id: string; name: string } };
    expect(body.data.id).toBe("abc-123");
    expect(body.data.name).toBe("Mock Agent");
  });
});
