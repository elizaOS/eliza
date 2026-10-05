/**
 * A password change through the real app HTTP server revokes every other
 * session of the identity — browser and machine — and closes their open
 * WebSockets, while the session that made the change keeps working. The
 * audit trail records how many sessions were revoked.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import {
  createDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import { resolveAuditLogPath } from "./auth/audit";
import { hashPassword } from "./auth/passwords";
import {
  createBrowserSession,
  createMachineSession,
  deriveCsrfToken,
  findActiveSession,
} from "./auth/sessions";
import { startApiServer } from "./server";

const OLD_PASSWORD = "old-password-1234";
const NEW_PASSWORD = "new-password-5678";
let stateDir: string;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let store: AuthStore;
let server: Awaited<ReturnType<typeof startApiServer>>;
const sockets: WebSocket[] = [];

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), 10_000),
    ),
  ]);
}

async function openAdmitted(
  sessionId: string,
): Promise<{ closed: Promise<number>; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: {
      Origin: `http://127.0.0.1:${server.port}`,
      Cookie: `eliza_session=${encodeURIComponent(sessionId)}`,
    },
  });
  sockets.push(ws);
  const closed = new Promise<number>((resolve) => {
    ws.on("close", (code) => resolve(code));
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { type?: string };
        if (frame.type === "pong") resolve();
      });
    }),
    "socket admission",
  );
  return { closed, ws };
}

describe("password change session revocation", { concurrent: false }, () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "eliza-password-change-"));
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_API_BIND", "127.0.0.1");
    vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
    vi.stubEnv("ELIZA_API_TOKEN", "password-change-test-static-token");
    vi.stubEnv("ELIZA_API_AUTH_TOKEN", "");
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    vi.stubEnv("ELIZA_ALLOW_WS_QUERY_TOKEN", "0");
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
    const runtime = new AgentRuntime({
      agentId,
      character: { name: "Password change test" },
      adapter,
    });
    server = await startApiServer({
      runtime,
      port: 0,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    if (server) await server.close();
    if (adapter) await adapter.close();
    if (stateDir)
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  it("revokes every other session and closes its sockets", async () => {
    const owner = await store.createIdentity({
      id: randomUUID(),
      kind: "owner",
      displayName: "Synthetic owner",
      createdAt: Date.now(),
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    const browserOptions = {
      identityId: owner.id,
      ip: null,
      userAgent: null,
      rememberDevice: false,
    };
    const current = (await createBrowserSession(store, browserOptions)).session;
    const other = (await createBrowserSession(store, browserOptions)).session;
    const machine = (
      await createMachineSession(store, {
        identityId: owner.id,
        scopes: [],
      })
    ).session;
    const kept = await openAdmitted(current.id);
    const revoked = await openAdmitted(other.id);

    const csrf = deriveCsrfToken(current);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/password/change`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
          cookie: `eliza_session=${encodeURIComponent(current.id)}; eliza_csrf=${csrf}`,
          "x-eliza-csrf": csrf,
        },
        body: JSON.stringify({
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      sessionsRevoked: number;
    };
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBe(2);

    expect(await withTimeout(revoked.closed, "revoked socket close")).toBe(
      1008,
    );
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);
    expect(await findActiveSession(store, current.id)).not.toBeNull();
    expect(await findActiveSession(store, other.id)).toBeNull();
    expect(await findActiveSession(store, machine.id)).toBeNull();

    const audit = (await readFile(resolveAuditLogPath(), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            action: string;
            outcome: string;
            metadata: Record<string, unknown>;
          },
      );
    expect(
      audit.find(
        (event) =>
          event.action === "auth.password.change" &&
          event.outcome === "success",
      )?.metadata,
    ).toMatchObject({
      localAccess: false,
      sessionsRevoked: body.sessionsRevoked,
    });
    expect(
      audit.find((event) => event.action === "auth.session.revoke_all")
        ?.metadata,
    ).toMatchObject({
      reason: "password_change",
      revoked: body.sessionsRevoked,
    });

    kept.ws.close();
    await withTimeout(kept.closed, "kept socket close");
  });
});
