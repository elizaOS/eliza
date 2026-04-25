/**
 * End-to-end API route tests.
 *
 * Wires `handleLocalInferenceCompatRoutes` into a real `http.Server`
 * listening on loopback, then makes real HTTP requests through `fetch`
 * against it. No mocked response objects, no vi.fn — real sockets, real
 * JSON, real routing.
 *
 * Covers every endpoint the UI uses: /hardware, /catalog, /installed,
 * /hub, /assignments (GET + POST), /device (status), /hf-search bad-query
 * fast-path, and the 404 fall-through for unknown paths.
 */

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleLocalInferenceCompatRoutes } from "./local-inference-compat-routes";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

async function startApiHarness(state: CompatRuntimeState): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleLocalInferenceCompatRoutes(req, res, state);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dispose: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

function emptyState(): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("local-inference-compat-routes e2e", () => {
  let harness: Harness;
  let tmpState: string;
  let origStateDir: string | undefined;
  let origToken: string | undefined;

  beforeEach(async () => {
    tmpState = await fs.mkdtemp(path.join(os.tmpdir(), "milady-api-e2e-"));
    origStateDir = process.env.ELIZA_STATE_DIR;
    origToken = process.env.ELIZA_API_TOKEN;
    process.env.ELIZA_STATE_DIR = tmpState;
    // No auth token set so loopback requests don't need one — matches the
    // dev default we verified earlier against the real running server.
    delete process.env.ELIZA_API_TOKEN;
    harness = await startApiHarness(emptyState());
  });

  afterEach(async () => {
    await harness.dispose();
    if (origStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = origStateDir;
    if (origToken === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = origToken;
    await fs.rm(tmpState, { recursive: true, force: true });
  });

  it("GET /api/local-inference/catalog returns the curated list", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }> };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
    expect(typeof body.models[0]?.id).toBe("string");
  });

  it("GET /api/local-inference/hardware probes real hardware", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/hardware`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalRamGb: number;
      platform: string;
      arch: string;
      recommendedBucket: string;
      source: string;
    };
    expect(body.totalRamGb).toBeGreaterThan(0);
    expect(typeof body.platform).toBe("string");
    expect(["small", "mid", "large", "xl"]).toContain(body.recommendedBucket);
    expect(["node-llama-cpp", "os-fallback"]).toContain(body.source);
  });

  it("GET /api/local-inference/installed returns a list (may include external-scan results)", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/installed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("GET /api/local-inference/hub merges catalog + installed + hardware + assignments", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/hub`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      catalog: unknown[];
      installed: unknown[];
      hardware: { totalRamGb: number };
      assignments: Record<string, string>;
    };
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(Array.isArray(body.installed)).toBe(true);
    expect(body.hardware.totalRamGb).toBeGreaterThan(0);
    expect(body.assignments).toEqual({});
  });

  it("GET /api/local-inference/assignments starts empty", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/local-inference/assignments`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignments: Record<string, string> };
    expect(body.assignments).toEqual({});
  });

  it("POST /api/local-inference/assignments persists + GET reads it back", async () => {
    const post = await fetch(
      `${harness.baseUrl}/api/local-inference/assignments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "TEXT_SMALL", modelId: "llama-3.2-1b" }),
      },
    );
    expect(post.status).toBe(200);
    const posted = (await post.json()) as {
      assignments: Record<string, string>;
    };
    expect(posted.assignments.TEXT_SMALL).toBe("llama-3.2-1b");

    const getRes = await fetch(
      `${harness.baseUrl}/api/local-inference/assignments`,
    );
    const body = (await getRes.json()) as {
      assignments: Record<string, string>;
    };
    expect(body.assignments.TEXT_SMALL).toBe("llama-3.2-1b");
  });

  it("POST /api/local-inference/assignments with modelId: null clears the slot", async () => {
    await fetch(`${harness.baseUrl}/api/local-inference/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "TEXT_SMALL", modelId: "llama-3.2-1b" }),
    });
    const clear = await fetch(
      `${harness.baseUrl}/api/local-inference/assignments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "TEXT_SMALL", modelId: null }),
      },
    );
    expect(clear.status).toBe(200);
    const body = (await clear.json()) as {
      assignments: Record<string, string>;
    };
    expect(body.assignments.TEXT_SMALL).toBeUndefined();
  });

  it("POST /api/local-inference/assignments rejects an unknown slot", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/local-inference/assignments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "NOT_A_SLOT", modelId: "x" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/local-inference/device reports empty status with no connected devices", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/device`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      devices: unknown[];
    };
    expect(body.connected).toBe(false);
    expect(body.devices).toHaveLength(0);
  });

  it("GET /api/local-inference/hf-search with empty query returns []", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/local-inference/hf-search?q=`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(body.models).toEqual([]);
  });

  it("returns 404 from our handler for an unrelated path (falls through)", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/nope`);
    expect(res.status).toBe(404);
  });

  it("POST /api/local-inference/installed/unknown/verify returns 404", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/local-inference/installed/does-not-exist/verify`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/local-inference/providers returns the full provider list", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/providers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; kind: string }>;
    };
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.some((p) => p.id === "milady-local-inference")).toBe(
      true,
    );
    expect(body.providers.some((p) => p.id === "anthropic")).toBe(true);
  });

  it("GET /api/local-inference/routing returns registrations + preferences", async () => {
    const res = await fetch(`${harness.baseUrl}/api/local-inference/routing`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registrations: unknown[];
      preferences: { preferredProvider: unknown; policy: unknown };
    };
    expect(Array.isArray(body.registrations)).toBe(true);
    expect(body.preferences.preferredProvider).toEqual({});
    expect(body.preferences.policy).toEqual({});
  });

  it("POST /api/local-inference/routing/preferred persists + survives a GET", async () => {
    const post = await fetch(
      `${harness.baseUrl}/api/local-inference/routing/preferred`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "TEXT_LARGE", provider: "openai" }),
      },
    );
    expect(post.status).toBe(200);
    const getRes = await fetch(
      `${harness.baseUrl}/api/local-inference/routing`,
    );
    const body = (await getRes.json()) as {
      preferences: { preferredProvider: Record<string, string> };
    };
    expect(body.preferences.preferredProvider.TEXT_LARGE).toBe("openai");
  });

  it("POST /api/local-inference/routing/policy validates the policy enum", async () => {
    const bad = await fetch(
      `${harness.baseUrl}/api/local-inference/routing/policy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "TEXT_LARGE", policy: "nonsense" }),
      },
    );
    expect(bad.status).toBe(400);

    const ok = await fetch(
      `${harness.baseUrl}/api/local-inference/routing/policy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "TEXT_LARGE", policy: "cheapest" }),
      },
    );
    expect(ok.status).toBe(200);
  });

  it("POST /api/local-inference/routing/preferred rejects an unknown slot", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/local-inference/routing/preferred`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: "NOT_A_SLOT", provider: "openai" }),
      },
    );
    expect(res.status).toBe(400);
  });
});
