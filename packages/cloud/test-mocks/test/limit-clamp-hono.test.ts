/**
 * Hono `app.request` coverage for strict `?limit=` and `?tail=` clamp on
 * the control-plane mock — `buildControlPlaneApp` in `@elizaos/cloud-test-mocks`.
 *
 * Covers:
 *   - `GET|POST /cron/process-provisioning-jobs?limit=`  → `parseClampedLimit(..., 1000, 1000)`
 *   - `GET /api/v1/containers/:id/logs?tail=`            → `parseClampedLimit(..., 200, 1000)`
 *
 * Proves strict `/^\d+$/` + isSafeInteger instead of the weak
 * `Number.parseInt` / `Number(...)` + isFinite/Math clamp that accepted
 * `5junk→5`, `1e4→1`, `0→1`, and left `1e4` unclamped for tail.
 *
 * Mutation-proof: reverting either handler to the weak parser changes
 * `processed` counts (limit) or `lineCount` (tail) and these assertions fail.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildControlPlaneApp } from "../src/control-plane/server";
import { startHetznerMock, type RunningHetznerMock } from "../src/hetzner";

process.env.MOCK_HETZNER_LATENCY = "0";
const TOKEN = "limit-clamp-test-token";

let hetzner: RunningHetznerMock;

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 5 });
});

afterAll(async () => {
  await hetzner.stop();
});

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-eliza-user-id": "user-1",
    "x-eliza-organization-id": "org-1",
    "content-type": "application/json",
  };
}

describe("control-plane mock limit clamp via app.request", () => {
  test("limit=5junk → fallback 1000 processes all (old parseInt → 5 would cap at 5)", async () => {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
    });
    // Seed 8 jobs — old limit 5 would leave 3 skipped, fixed limit 1000 processes all 8
    for (let i = 0; i < 8; i += 1) {
      const r = await app.request("/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(r.status).toBe(201);
    }
    const res = await app.request("/api/v1/cron/process-provisioning-jobs?limit=5junk", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { processed: number; skipped: number } };
    expect(body.success).toBe(true);
    // Fixed fallback 1000 → all 8 processed; weak 5 would have skipped ≥3
    expect(body.data.processed).toBe(8);
    expect(body.data.skipped).toBe(0);
  });

  test("limit=1e4 → fallback 1000 processes all (old parseInt → 1 would process 1)", async () => {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
    });
    for (let i = 0; i < 3; i += 1) {
      const r = await app.request("/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(r.status).toBe(201);
    }
    const res = await app.request("/api/v1/cron/process-provisioning-jobs?limit=1e4", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { processed: number } };
    expect(body.data.processed).toBe(3);
  });

  test("limit=0 → fallback 1000 (old fallback also 1000, but proves >0 guard)", async () => {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
    });
    for (let i = 0; i < 2; i += 1) {
      const r = await app.request("/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(r.status).toBe(201);
    }
    const res = await app.request("/api/v1/cron/process-provisioning-jobs?limit=0", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { processed: number } };
    expect(body.data.processed).toBe(2);
  });

  test("limit=2 → caps at 2 (valid path)", async () => {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
    });
    for (let i = 0; i < 4; i += 1) {
      const r = await app.request("/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(r.status).toBe(201);
    }
    const res = await app.request("/api/v1/cron/process-provisioning-jobs?limit=2", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { processed: number; skipped: number } };
    expect(body.data.processed).toBe(2);
    expect(body.data.skipped).toBe(2);
  });
});

describe("control-plane mock tail clamp via app.request", () => {
  async function fetchTailLines(tailQuery: string, logLines: string[]): Promise<string[]> {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
      containerLogLines: logLines,
    });
    // Create a container to get an id
    const createRes = await app.request("/api/v1/containers", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "c1", project_name: "p1", image: "img" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string } };
    const id = created.data.id;
    const logsRes = await app.request(`/api/v1/containers/${id}/logs${tailQuery}`, {
      headers: authHeaders(),
    });
    expect(logsRes.status).toBe(200);
    const text = await logsRes.text();
    return text.length === 0 ? [] : text.split("\n");
  }

  test("tail=1e4 → fallback 200 returns 200 lines (old Number 10000 would return all 500)", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=1e4", lines);
    expect(returned.length).toBe(200);
    // Must be the last 200 lines, not the first
    expect(returned[0]).toBe("line-300");
    expect(returned[returned.length - 1]).toBe("line-499");
  });

  test("tail=2000 → clamped to 1000 returns 1000 lines (old would return 2000)", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=2000", lines);
    expect(returned.length).toBe(1000);
    expect(returned[0]).toBe("line-1500");
  });

  test("tail=5.5 → fallback 200 (old Number 5.5 → floor 5 would return 5)", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=5.5", lines);
    expect(returned.length).toBe(200);
  });

  test("tail=0 → fallback 200 (old Math.max 1,0 → 1 would return 1)", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=0", lines);
    expect(returned.length).toBe(50); // only 50 exist, so all 50 (min 50,200)
    // With 500 lines, 0 → 200
    const lines500 = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const returned2 = await fetchTailLines("?tail=0", lines500);
    expect(returned2.length).toBe(200);
  });

  test("tail=50 → exact 50", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=50", lines);
    expect(returned.length).toBe(50);
    expect(returned[0]).toBe("line-150");
  });
});
