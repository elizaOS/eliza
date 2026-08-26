/** Exercises auth bridge behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import {
  loadOrCreateDesktopSession,
  loadPersistedSession,
  persistSession,
  resolveAuthDir,
  resolveSessionPath,
  resolveShortSocketDir,
} from "./auth-bridge";

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

const tempRoots: string[] = [];

function createStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-auth-bridge-"));
  tempRoots.push(dir);
  return dir;
}

describe("desktop auth bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("logs malformed persisted desktop sessions before falling through", () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    fs.mkdirSync(resolveAuthDir(env), { recursive: true });
    const sessionPath = resolveSessionPath(env);
    fs.writeFileSync(sessionPath, "{", "utf8");

    expect(loadPersistedSession(env, () => 1_700_000_000_000)).toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      "[DesktopAuthBridge] Failed to parse persisted desktop session",
      expect.objectContaining({
        sessionPath,
        error: expect.any(String),
      }),
    );
  });

  it("treats a missing persisted desktop session as normal first-run state", () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };

    expect(loadPersistedSession(env, () => 1_700_000_000_000)).toBeNull();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses a private child directory for short macOS bootstrap sockets", () => {
    expect(resolveShortSocketDir("/private/var/tmp", 501)).toBe(
      "/private/var/tmp/eza-dx",
    );
  });

  it("mints fresh authority for a new embedded backend generation", async () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    persistSession(
      {
        sessionId: "stale-session",
        csrfToken: "stale-csrf",
        expiresAt: Date.now() + 86_400_000,
      },
      env,
    );

    const fresh = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env,
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 7),
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { socketPath: string };
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(body.socketPath);
          socket.once("error", reject);
          socket.on("data", () => undefined);
          socket.once("end", resolve);
        });
        return Response.json({
          sessionId: "fresh-session",
          csrfToken: "fresh-csrf",
          expiresAt: Date.now() + 86_400_000,
        });
      },
    });

    expect(fresh).toMatchObject({
      sessionId: "fresh-session",
      csrfToken: "fresh-csrf",
    });
    expect(loadPersistedSession(env)?.sessionId).toBe("fresh-session");
  });

  it("retries transient database startup without replacing the proof socket", async () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    const socketPaths: string[] = [];
    let attempts = 0;

    const fresh = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env,
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 9),
      fetchImpl: async (_input, init) => {
        attempts += 1;
        const body = JSON.parse(String(init?.body)) as { socketPath: string };
        socketPaths.push(body.socketPath);
        if (attempts === 1) {
          return Response.json({ error: "db_unavailable" }, { status: 503 });
        }
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(body.socketPath);
          socket.once("error", reject);
          socket.on("data", () => undefined);
          socket.once("end", resolve);
        });
        return Response.json({
          sessionId: "retry-session",
          csrfToken: "retry-csrf",
          expiresAt: Date.now() + 86_400_000,
        });
      },
    });

    expect(fresh?.sessionId).toBe("retry-session");
    expect(attempts).toBe(2);
    expect(new Set(socketPaths).size).toBe(1);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "[DesktopAuthBridge] Desktop auth bootstrap endpoint failed",
      expect.objectContaining({ status: 503 }),
    );
  });

  it("starts the proof deadline after a bounded 503 retry ladder", async () => {
    const stateDir = createStateDir();
    let attempts = 0;

    const fresh = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env: { ELIZA_STATE_DIR: stateDir },
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 10),
      timing: {
        httpRequestTimeoutMs: 1_000,
        socketConnectTimeoutMs: 10,
        dbUnavailableRetryDelaysMs: [25],
      },
      fetchImpl: async (_input, init) => {
        attempts += 1;
        const body = JSON.parse(String(init?.body)) as { socketPath: string };
        if (attempts === 1) {
          return Response.json({ error: "db_unavailable" }, { status: 503 });
        }
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(body.socketPath);
          socket.once("error", reject);
          socket.on("data", () => undefined);
          socket.once("end", resolve);
        });
        return Response.json({
          sessionId: "post-retry-session",
          csrfToken: "post-retry-csrf",
          expiresAt: Date.now() + 86_400_000,
        });
      },
    });

    expect(attempts).toBe(2);
    expect(fresh?.sessionId).toBe("post-retry-session");
  });

  it("does not retry a rejected desktop proof", async () => {
    const stateDir = createStateDir();
    let attempts = 0;

    const session = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env: { ELIZA_STATE_DIR: stateDir },
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 11),
      fetchImpl: async () => {
        attempts += 1;
        return Response.json(
          { error: "desktop_bootstrap_proof_failed" },
          { status: 403 },
        );
      },
    });

    expect(session).toBeNull();
    expect(attempts).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[DesktopAuthBridge] Desktop auth bootstrap endpoint failed",
      expect.objectContaining({ status: 403 }),
    );
  });

  it("does not retry an unrelated 503 response", async () => {
    const stateDir = createStateDir();
    let attempts = 0;

    const session = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env: { ELIZA_STATE_DIR: stateDir },
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 12),
      fetchImpl: async () => {
        attempts += 1;
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      },
    });

    expect(session).toBeNull();
    expect(attempts).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[DesktopAuthBridge] Desktop auth bootstrap endpoint failed",
      expect.objectContaining({ status: 503 }),
    );
  });

  it("does not retry db_unavailable after the proof was consumed", async () => {
    const stateDir = createStateDir();
    let attempts = 0;

    const session = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env: { ELIZA_STATE_DIR: stateDir },
      reusePersistedSession: false,
      generateSecret: () => Buffer.alloc(32, 13),
      fetchImpl: async (_input, init) => {
        attempts += 1;
        const body = JSON.parse(String(init?.body)) as { socketPath: string };
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(body.socketPath);
          socket.once("error", reject);
          socket.on("data", () => undefined);
          socket.once("close", resolve);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        return Response.json({ error: "db_unavailable" }, { status: 503 });
      },
    });

    expect(session).toBeNull();
    expect(attempts).toBe(1);
  });
});
