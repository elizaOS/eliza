/**
 * First-run owner setup through the real auth session route handler and a
 * PGlite-backed auth store. Concurrent setup POSTs must serialize on the
 * check-and-create so exactly one owner identity is created, the loser gets
 * 409, and no request hangs on the setup lock.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import { handleAuthSessionRoutes } from "./auth-session-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

const PASSWORD = "setup-password-1234";

let stateDir: string;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let store: AuthStore;
let server: http.Server;
let baseUrl: string;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), 10_000),
    ),
  ]);
}

function postSetup(displayName: string): Promise<Response> {
  return withTimeout(
    fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, password: PASSWORD }),
    }),
    `setup for ${displayName}`,
  );
}

describe("POST /api/auth/setup", { concurrent: false }, () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "eliza-auth-setup-"));
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    const agentId = randomUUID();
    adapter = createDatabaseAdapter(
      { dataDir: path.join(stateDir, "db") },
      agentId,
    );
    await adapter.initialize();
    const db = adapter.db;
    if (!db || !adapter.runPluginMigrations) {
      throw new Error("PGlite adapter did not expose its database");
    }
    await adapter.runPluginMigrations([sqlPlugin]);
    store = new AuthStore(db as DrizzleDatabase);
    const state = {
      current: { agentId, adapter },
      pendingAgentName: null,
      pendingRestartReasons: [],
    } as unknown as CompatRuntimeState;
    server = http.createServer((req, res) => {
      handleAuthSessionRoutes(req, res, state).then(
        (handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        },
        (err: unknown) => {
          res.statusCode = 500;
          res.end(String(err));
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (adapter) await adapter.close();
    if (stateDir)
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  it("creates exactly one owner when two setup requests race", async () => {
    const responses = await Promise.all([
      postSetup("First owner"),
      postSetup("Second owner"),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);

    const winner = responses.find((response) => response.status === 200);
    const loser = responses.find((response) => response.status === 409);
    const winnerBody = (await winner?.json()) as {
      identity: { id: string; displayName: string; kind: string };
    };
    expect(winnerBody.identity.kind).toBe("owner");
    expect(await loser?.json()).toMatchObject({
      error: "already_initialized",
    });

    const owners = await store.listIdentitiesByKind("owner");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.id).toBe(winnerBody.identity.id);
  });

  it("rejects a later setup once an owner exists", async () => {
    const response = await postSetup("Late owner");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "already_initialized",
    });
    expect(await store.listIdentitiesByKind("owner")).toHaveLength(1);
  });
});
