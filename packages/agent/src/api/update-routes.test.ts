import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { handleUpdateRoutes } from "./update-routes.ts";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_UPDATE_CHANNEL",
] as const;
const savedEnv = new Map<string, string | undefined>();
let stateDir: string;

function registryResponse(): Response {
  return new Response(
    JSON.stringify({
      "dist-tags": { latest: "99.0.0", beta: "99.1.0-beta.1" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function getStatus(
  config: ElizaConfig,
  requestUrl = "/api/update/status",
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const req = {
    url: requestUrl,
    method: "GET",
    headers: { host: "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const handled = await handleUpdateRoutes({
    req,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/update/status",
    url: new URL(requestUrl, "http://127.0.0.1"),
    state: { config },
    json: (_res, data) => {
      body = data as Record<string, unknown>;
    },
    error: (_res, message) => {
      throw new Error(message);
    },
    readJsonBody: async () => null,
    saveElizaConfig,
  });
  expect(handled).toBe(true);
  if (!body) throw new Error("route did not answer");
  return body;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-routes-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_UPDATE_CHANNEL;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => registryResponse()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(stateDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/update/status lastCheckAt", () => {
  it("reports the time a live check saved on a fresh install", async () => {
    const before = Date.now();
    const body = await getStatus({});

    const saved = loadElizaConfig().update?.lastCheckAt;
    expect(saved).toBeTypeOf("string");
    expect(body.latestVersion).toBe("99.0.0");
    expect(body.lastCheckAt).toBe(saved);
    expect(Date.parse(String(body.lastCheckAt))).toBeGreaterThanOrEqual(
      before - 1_000,
    );
  });

  it("moves forward when Check now forces a live check", async () => {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const update = {
      channel: "stable" as const,
      lastCheckAt: earlier,
      lastCheckVersion: "98.0.0",
      lastCheckChannel: "stable" as const,
    };
    saveElizaConfig({ update });
    const config: ElizaConfig = { update: { ...update } };

    const body = await getStatus(config, "/api/update/status?force=true");

    const saved = loadElizaConfig().update?.lastCheckAt;
    expect(saved).not.toBe(earlier);
    expect(body.lastCheckAt).toBe(saved);
  });

  it("reports the stored time when the check is served from the cache", async () => {
    const stored = new Date(Date.now() - 60_000).toISOString();
    saveElizaConfig({
      update: {
        lastCheckAt: stored,
        lastCheckVersion: "98.0.0",
        lastCheckChannel: "stable",
      },
    });

    // The server's in-memory config predates the cached check.
    const body = await getStatus({});

    expect(body.latestVersion).toBe("98.0.0");
    expect(body.lastCheckAt).toBe(stored);
  });

  it("keeps the saved check when another route persists the in-memory config", async () => {
    const config: ElizaConfig = {};
    const body = await getStatus(config);
    const saved = loadElizaConfig().update;

    // Any other writer (connectors, permissions, model config) saves the
    // whole in-memory config back to disk.
    saveElizaConfig(config);

    const after = loadElizaConfig().update;
    expect(saved?.lastCheckAt).toBeTypeOf("string");
    expect(after?.lastCheckAt).toBe(saved?.lastCheckAt);
    expect(body.lastCheckAt).toBe(saved?.lastCheckAt);
    expect(after?.lastCheckVersion).toBe("99.0.0");
    expect(after?.lastCheckChannel).toBe("stable");
  });
});
