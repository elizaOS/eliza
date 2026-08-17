/**
 * Exercises provisioning and log-tail limits through the stateful control-plane mock.
 * The integration harness uses a real local Hetzner mock and inspects resulting jobs and logs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildControlPlaneApp } from "../src/control-plane/server";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

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
  test("trailing-junk limit falls back to 1000", async () => {
    const { app } = buildControlPlaneApp({
      token: TOKEN,
      hetznerUrl: hetzner.url,
      hetznerToken: "h",
      expectedAuxToken: "",
    });
    // More than five jobs distinguishes the fallback from a parsed prefix.
    for (let i = 0; i < 8; i += 1) {
      const r = await app.request("/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "agent_provision" }),
      });
      expect(r.status).toBe(201);
    }
    const res = await app.request(
      "/api/v1/cron/process-provisioning-jobs?limit=5junk",
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { processed: number; skipped: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.processed).toBe(8);
    expect(body.data.skipped).toBe(0);
  });

  test("scientific-notation limit falls back to 1000", async () => {
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
    const res = await app.request(
      "/api/v1/cron/process-provisioning-jobs?limit=1e4",
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { processed: number };
    };
    expect(body.data.processed).toBe(3);
  });

  test("zero limit falls back to 1000", async () => {
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
    const res = await app.request(
      "/api/v1/cron/process-provisioning-jobs?limit=0",
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { processed: number };
    };
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
    const res = await app.request(
      "/api/v1/cron/process-provisioning-jobs?limit=2",
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { processed: number; skipped: number };
    };
    expect(body.data.processed).toBe(2);
    expect(body.data.skipped).toBe(2);
  });
});

describe("control-plane mock tail clamp via app.request", () => {
  async function fetchTailLines(
    tailQuery: string,
    logLines: string[],
  ): Promise<string[]> {
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
    const logsRes = await app.request(
      `/api/v1/containers/${id}/logs${tailQuery}`,
      {
        headers: authHeaders(),
      },
    );
    expect(logsRes.status).toBe(200);
    const text = await logsRes.text();
    return text.length === 0 ? [] : text.split("\n");
  }

  test("scientific-notation tail returns the fallback 200 lines", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=1e4", lines);
    expect(returned.length).toBe(200);
    // Tail semantics return the most recent lines.
    expect(returned[0]).toBe("line-300");
    expect(returned[returned.length - 1]).toBe("line-499");
  });

  test("oversize tail is clamped to 1000 lines", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=2000", lines);
    expect(returned.length).toBe(1000);
    expect(returned[0]).toBe("line-1500");
  });

  test("decimal tail returns the fallback 200 lines", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=5.5", lines);
    expect(returned.length).toBe(200);
  });

  test("zero tail returns the fallback 200 lines", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const returned = await fetchTailLines("?tail=0", lines);
    expect(returned.length).toBe(50);
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
