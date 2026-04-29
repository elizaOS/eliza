import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSecretsManagerRoute } from "./secrets-manager-routes";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

async function startApiHarness(): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleSecretsManagerRoute(
        req,
        res,
        url.pathname,
        (req.method ?? "GET").toUpperCase(),
      );
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("secrets-manager routes", () => {
  let harness: Harness | null;
  let workDir: string | null;
  let originalStateDir: string | undefined;
  let originalElizaStateDir: string | undefined;

  beforeEach(async () => {
    harness = null;
    // Isolate vault state in a fresh tmp dir per test so preferences
    // reads/writes don't leak across cases or stomp on a real ~/.milady.
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-secrets-routes-"));
    originalStateDir = process.env.MILADY_STATE_DIR;
    originalElizaStateDir = process.env.ELIZA_STATE_DIR;
    process.env.MILADY_STATE_DIR = workDir;
    process.env.ELIZA_STATE_DIR = workDir;
  });

  afterEach(async () => {
    await harness?.dispose();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.MILADY_STATE_DIR;
    else process.env.MILADY_STATE_DIR = originalStateDir;
    if (originalElizaStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = originalElizaStateDir;
  });

  it("GET /api/secrets/manager/backends returns the four-entry status array", async () => {
    harness = await startApiHarness();
    const response = await fetch(`${harness.baseUrl}/api/secrets/manager/backends`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      backends: Array<{ id: string; label: string; available: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.backends)).toBe(true);
    expect(body.backends.length).toBe(4);
    const ids = body.backends.map((b) => b.id).sort();
    expect(ids).toEqual(["1password", "bitwarden", "in-house", "protonpass"]);
    // in-house is always available regardless of host tooling.
    const inHouse = body.backends.find((b) => b.id === "in-house");
    expect(inHouse?.available).toBe(true);
  });

  it("GET /api/secrets/manager/preferences returns DEFAULT_PREFERENCES initially", async () => {
    harness = await startApiHarness();
    const response = await fetch(
      `${harness.baseUrl}/api/secrets/manager/preferences`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      preferences: { enabled: string[]; routing?: Record<string, string> };
    };
    expect(body.ok).toBe(true);
    // No prefs persisted yet → DEFAULT_PREFERENCES { enabled: ["in-house"] }.
    expect(body.preferences.enabled).toEqual(["in-house"]);
  });

  it("PUT /api/secrets/manager/preferences persists and round-trips", async () => {
    harness = await startApiHarness();
    const next = {
      enabled: ["1password", "in-house"],
      routing: { OPENAI_API_KEY: "1password" as const },
    };
    const putResponse = await fetch(
      `${harness.baseUrl}/api/secrets/manager/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences: next }),
      },
    );
    expect(putResponse.status).toBe(200);
    const putBody = (await putResponse.json()) as {
      ok: boolean;
      preferences: { enabled: string[]; routing?: Record<string, string> };
    };
    expect(putBody.ok).toBe(true);
    expect(putBody.preferences.enabled).toEqual(["1password", "in-house"]);
    expect(putBody.preferences.routing?.OPENAI_API_KEY).toBe("1password");

    // Subsequent GET should return the saved prefs.
    const getResponse = await fetch(
      `${harness.baseUrl}/api/secrets/manager/preferences`,
    );
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      preferences: { enabled: string[]; routing?: Record<string, string> };
    };
    expect(getBody.preferences.enabled).toEqual(["1password", "in-house"]);
    expect(getBody.preferences.routing?.OPENAI_API_KEY).toBe("1password");
  });

  it("PUT with malformed JSON body returns 400", async () => {
    harness = await startApiHarness();
    const response = await fetch(
      `${harness.baseUrl}/api/secrets/manager/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "}{ not json",
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid JSON/i);
  });

  it("PUT missing the `preferences` field returns 400", async () => {
    harness = await startApiHarness();
    const response = await fetch(
      `${harness.baseUrl}/api/secrets/manager/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrongField: { enabled: ["in-house"] } }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/preferences/i);
  });

  it("does not claim paths outside /api/secrets/manager", async () => {
    // Drives the harness, which only invokes `handleSecretsManagerRoute`.
    // If the handler claims the request (returns true) it would write a
    // response body — instead the harness 404 path runs, proving the
    // handler returned false.
    harness = await startApiHarness();
    const response = await fetch(
      `${harness.baseUrl}/api/secrets/something-else`,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not-found");
  });
});
