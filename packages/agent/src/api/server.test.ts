/**
 * Startup and lifecycle contract for the agent API entrypoint in
 * api/server.ts. Configuration problems must fail API startup before any
 * listener exists — a malformed connector-health interval with the typed
 * CONNECTOR_HEALTH_INTERVAL_INVALID code, and a malformed agent config file
 * with the fatal AGENT_CONFIG_LOAD_FAILED code — while an absent config file
 * stays legitimate first-run state. On the happy path an explicit `port`
 * option outranks the ELIZA_API_PORT env default, the bound socket answers a
 * real request, and close() releases the ephemeral port. The exported
 * resolveTradePermissionMode accepts exactly the three documented modes and
 * falls back to "user-sign-only" otherwise.
 *
 * Harness: every case boots the real `startApiServer` on an ephemeral
 * loopback port over a throwaway state dir; no route or module mocks. Ports
 * stay ephemeral because several test lanes share one host.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { resolveTradePermissionMode, startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "server-contract-test-api-token";

const touchedEnv = [
  "CONNECTOR_HEALTH_INTERVAL_MS",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_STATE_DIR",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STEWARD_WALLET_CACHE_BLOCKING",
  "ELIZA_WALLET_AUTO_PROVISION",
  "ELIZA_WALLET_OS_STORE",
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
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-server-contract-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.CONNECTOR_HEALTH_INTERVAL_MS;
  delete process.env.ELIZA_API_PORT;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_WALLET_AUTO_PROVISION;
  delete process.env.ELIZA_STEWARD_WALLET_CACHE_BLOCKING;
  delete process.env.ELIZA_WALLET_OS_STORE;
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

/** Boots a real listening server and registers it for afterEach teardown. */
async function boot(): Promise<ApiServer> {
  api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
  });
  return api;
}

function withTradeMode(value: unknown): ElizaConfig {
  return {
    features: { tradePermissionMode: value },
  } as unknown as ElizaConfig;
}

describe("startApiServer fail-fast configuration gates", () => {
  it.each(["10000junk", "9999", "1e4", "2147483648"])(
    "rejects CONNECTOR_HEALTH_INTERVAL_MS=%s before any listener exists",
    async (value) => {
      process.env.CONNECTOR_HEALTH_INTERVAL_MS = value;
      await expect(
        startApiServer({ port: 0, skipDeferredStartupWork: true }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "CONNECTOR_HEALTH_INTERVAL_INVALID",
        }),
      );
    },
  );

  it("fails startup with a fatal AGENT_CONFIG_LOAD_FAILED error when the config file is malformed", async () => {
    expect(stateDir).toBeTruthy();
    await writeFile(
      path.join(stateDir as string, "eliza.json"),
      "{ not json",
      "utf-8",
    );
    await expect(
      startApiServer({ port: 0, skipDeferredStartupWork: true }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "AGENT_CONFIG_LOAD_FAILED",
        severity: "fatal",
      }),
    );
  });

  it("treats an absent config file as first-run state instead of a failure", async () => {
    const started = await boot();
    expect(started.port).toBeGreaterThan(0);
  });
});

describe("startApiServer listener lifecycle", () => {
  it("binds the requested ephemeral port, answers a real request, and releases the port on close", async () => {
    const started = await boot();
    expect(started.port).toBeGreaterThan(0);
    const healthUrl = `http://127.0.0.1:${started.port}/api/health`;

    const live = await fetch(healthUrl);
    expect(live.status).toBe(200);
    const body = (await live.json()) as Record<string, unknown>;
    expect(typeof body.ready).toBe("boolean");

    await started.close();
    api = null;
    // The same address now refuses connections rather than answering.
    await expect(fetch(healthUrl)).rejects.toThrow();
  });

  it("lets an explicit opts.port win over the ELIZA_API_PORT env default", async () => {
    process.env.ELIZA_API_PORT = "45657";
    const started = await boot();
    expect(started.port).not.toBe(45657);
    expect(started.port).toBeGreaterThan(0);
  });
});

describe("resolveTradePermissionMode", () => {
  it.each(["user-sign-only", "manual-local-key", "agent-auto"] as const)(
    "passes through the configured %s mode",
    (mode) => {
      expect(resolveTradePermissionMode(withTradeMode(mode))).toBe(mode);
    },
  );

  it.each([undefined, null, "", "AGENT-AUTO", "agent-full-auto", 3])(
    "falls back to user-sign-only for %p",
    (value) => {
      expect(resolveTradePermissionMode(withTradeMode(value))).toBe(
        "user-sign-only",
      );
    },
  );

  it("falls back to user-sign-only when no features are configured at all", () => {
    expect(resolveTradePermissionMode({} as ElizaConfig)).toBe(
      "user-sign-only",
    );
  });
});
