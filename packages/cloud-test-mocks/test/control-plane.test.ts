import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHetznerMock, type RunningHetznerMock } from "../src/hetzner";
import { startControlPlaneMock, type RunningControlPlaneMock } from "../src/control-plane";

process.env.MOCK_HETZNER_LATENCY = "0";

const TOKEN = "test-token";

let hetzner: RunningHetznerMock;
let controlPlane: RunningControlPlaneMock;
const clock = { current: new Date("2026-01-01T00:00:00Z") };

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 30 });
  controlPlane = await startControlPlaneMock({
    token: TOKEN,
    hetznerUrl: hetzner.url,
    hetznerToken: "hetzner-test-token",
    now: () => clock.current,
    hetznerActionPollTimeoutMs: 2000,
  });
});

afterAll(async () => {
  await controlPlane.stop();
  await hetzner.stop();
});

function cpFetch(path: string, init: RequestInit = {}, opts: { auth?: boolean; org?: boolean } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (opts.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.org !== false) {
    headers["x-eliza-user-id"] = "user-1";
    headers["x-eliza-organization-id"] = "org-1";
  }
  return fetch(`${controlPlane.url}${path}`, { ...init, headers });
}

async function pollSandbox(id: string, predicate: (status: string) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await cpFetch(`/sandboxes/${id}`);
    const body = (await res.json()) as { data?: { status: string } };
    if (body.data && predicate(body.data.status)) return body.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`sandbox ${id} never reached desired state`);
}

describe("control-plane mock auth", () => {
  test("missing token → 401", async () => {
    const res = await cpFetch("/jobs", { method: "POST", body: "{}" }, { auth: false });
    expect(res.status).toBe(401);
  });

  test("missing forwarded user/org headers → 400", async () => {
    const res = await cpFetch(
      "/jobs",
      { method: "POST", body: JSON.stringify({ type: "agent_provision" }) },
      { org: false },
    );
    expect(res.status).toBe(400);
  });

  test("health endpoint is public", async () => {
    const res = await fetch(`${controlPlane.url}/health`);
    expect(res.ok).toBe(true);
  });
});

describe("control-plane mock provision flow", () => {
  test("POST /jobs creates sandbox + job; tick provisions via hetzner; sandbox becomes running", async () => {
    const createRes = await cpFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({ type: "agent_provision", agent_id: "agent-1" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      data: { job: { id: string; status: string }; sandbox: { id: string; status: string } };
    };
    expect(created.data.job.status).toBe("pending");
    expect(created.data.sandbox.status).toBe("provisioning");

    const tickRes = await cpFetch("/cron/process-provisioning-jobs", { method: "POST" });
    expect(tickRes.ok).toBe(true);
    const tick = (await tickRes.json()) as { data: { processed: number; failed: number } };
    expect(tick.data.processed).toBe(1);
    expect(tick.data.failed).toBe(0);

    const sandbox = await pollSandbox(created.data.sandbox.id, (s) => s === "running");
    expect(sandbox.status).toBe("running");

    const jobRes = await cpFetch(`/jobs/${created.data.job.id}`);
    const jobBody = (await jobRes.json()) as { data: { status: string } };
    expect(jobBody.data.status).toBe("completed");
  });
});

describe("control-plane mock delete flow", () => {
  test("POST /jobs (agent_delete) deletes sandbox + hetzner server", async () => {
    // First provision a sandbox.
    const createRes = await cpFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({ type: "agent_provision" }),
    });
    const created = (await createRes.json()) as {
      data: { sandbox: { id: string } };
    };
    await cpFetch("/cron/process-provisioning-jobs", { method: "POST" });
    await pollSandbox(created.data.sandbox.id, (s) => s === "running");

    // Queue delete.
    const deleteRes = await cpFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({ type: "agent_delete", sandbox_id: created.data.sandbox.id }),
    });
    expect(deleteRes.status).toBe(201);
    const deleteBody = (await deleteRes.json()) as {
      data: { sandbox: { status: string } };
    };
    expect(deleteBody.data.sandbox.status).toBe("deletion_pending");

    await cpFetch("/cron/process-provisioning-jobs", { method: "POST" });
    const sandbox = await pollSandbox(created.data.sandbox.id, (s) => s === "deleted");
    expect(sandbox.status).toBe("deleted");
  });
});

describe("control-plane mock stuck cleanup", () => {
  test("cleanup-stuck-provisioning fails sandboxes older than 10min using injected clock", async () => {
    clock.current = new Date("2026-02-01T00:00:00Z");

    // Create a sandbox but never tick.
    const createRes = await cpFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({ type: "agent_provision" }),
    });
    const created = (await createRes.json()) as { data: { sandbox: { id: string }; job: { id: string } } };

    // Advance clock past 10min cutoff.
    clock.current = new Date(clock.current.getTime() + 11 * 60 * 1000);

    const cleanupRes = await cpFetch("/cron/cleanup-stuck-provisioning", { method: "POST" });
    const cleanup = (await cleanupRes.json()) as { data: { failed: number } };
    expect(cleanup.data.failed).toBe(1);

    const sandboxRes = await cpFetch(`/sandboxes/${created.data.sandbox.id}`);
    const sandboxBody = (await sandboxRes.json()) as { data: { status: string; errorReason?: string } };
    expect(sandboxBody.data.status).toBe("error");
    expect(sandboxBody.data.errorReason).toContain("stuck");

    const jobRes = await cpFetch(`/jobs/${created.data.job.id}`);
    const jobBody = (await jobRes.json()) as { data: { status: string } };
    expect(jobBody.data.status).toBe("failed");
  });
});
