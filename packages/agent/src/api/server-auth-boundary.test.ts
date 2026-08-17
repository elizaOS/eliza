/**
 * Real-server contract for three agent API auth-boundary fixes:
 *  - W1-010: GET /api/cloud/status and /api/cloud/credits no longer bypass the
 *    token gate — an unauthenticated caller who merely reaches the port gets
 *    401 instead of the owner's cloud userId/organizationId/credit balance.
 *  - W1-039: GET /api/health keeps its unauthenticated liveness bit but trims
 *    the topology detail (connectors, plugin/service counts, DB internals,
 *    boot phase) for callers that fail the trusted-local check.
 *  - W1-011: the device-bridge WS path fails closed (HTTP 404) when the
 *    bridge cannot be attached, instead of skipping WS auth unconditionally.
 * Boots the real `startApiServer` on an ephemeral loopback port with an
 * explicit API token; a remote caller is simulated with a non-loopback
 * X-Forwarded-For, which the trusted-local classifier treats as untrusted.
 */

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApiServer } from "./server.ts";

// The gate contract under test lives in server.ts. The cloud plugin's own
// handler is NOT exercised here: under the source-alias test environment the
// real `@elizaos/plugin-elizacloud` module graph fails to evaluate (ENOTDIR
// on its internal route scan) and the request 500s after passing the gate —
// pre-existing behavior unrelated to the auth boundary. The authorized-caller
// cases therefore assert the gate decision (no 401), while the 401 case
// proves the unauthorized response.

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "auth-boundary-test-api-token";

const touchedEnv = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_DEVICE_BRIDGE_TOKEN",
  "ELIZA_DEVICE_PAIRING_TOKEN",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
] as const;

const originalEnv = new Map<string, string | undefined>();

function snapshotEnvironment(): void {
  originalEnv.clear();
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
}

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

let stateDir: string | null = null;
let api: ApiServer | null = null;

beforeEach(async () => {
  snapshotEnvironment();
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-auth-boundary-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
  delete process.env.ELIZA_DEVICE_BRIDGE_TOKEN;
});

afterEach(async () => {
  if (api) {
    await api.close();
    api = null;
  }
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = null;
  }
  restoreEnvironment();
});

async function bootServer(): Promise<string> {
  api = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  process.env.ELIZA_PORT = String(api.port);
  process.env.ELIZA_API_PORT = String(api.port);
  return `http://127.0.0.1:${api.port}`;
}

/** Headers that make a loopback test client look like a proxied remote peer. */
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.10" } as const;

function wsUpgradeResponse(port: number, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("timed out waiting for the upgrade rejection"));
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(raw);
      }
    });
  });
}

describe("cloud session reads require authorization (W1-010)", () => {
  it("rejects unauthenticated remote callers on /api/cloud/status and /api/cloud/credits", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        headers: REMOTE_HEADERS,
      });
      expect(res.status, pathname).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.userId, pathname).toBeUndefined();
      expect(body.organizationId, pathname).toBeUndefined();
      expect(body.balance, pathname).toBeUndefined();
    }
  }, 120_000);

  it("still lets a bearer-token caller through the gate", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        headers: {
          ...REMOTE_HEADERS,
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      // Not 401: the request passes the gate and reaches dispatch (see the
      // comment above for why no stronger status is asserted here).
      expect(res.status, pathname).not.toBe(401);
    }
  }, 120_000);

  it("still lets the trusted loopback dashboard through the gate", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status, pathname).not.toBe(401);
    }
  }, 120_000);
});

describe("/api/health topology trim (W1-039)", () => {
  it("returns only the liveness bit to untrusted callers", async () => {
    const baseUrl = await bootServer();
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: REMOTE_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.ready).toBe("boolean");
    expect(body.connectors).toBeUndefined();
    expect(body.plugins).toBeUndefined();
    expect(body.services).toBeUndefined();
    expect(body.databaseLiveness).toBeUndefined();
    expect(body.agentState).toBeUndefined();
    expect(body.startup).toBeUndefined();
    expect(body.deferredBoot).toBeUndefined();
  }, 120_000);

  it("returns the full subsystem detail to trusted loopback callers", async () => {
    const baseUrl = await bootServer();
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.ready).toBe("boolean");
    expect(body.plugins).toBeDefined();
    expect(body.services).toBeDefined();
    expect(body.connectors).toBeDefined();
  }, 120_000);
});

describe("device-bridge WS upgrade gate (W1-011)", () => {
  it("rejects the device-bridge upgrade with 404 when the bridge cannot attach", async () => {
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);
    const raw = await wsUpgradeResponse(
      port,
      "/api/local-inference/device-bridge",
    );
    expect(raw.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
  }, 120_000);
});
