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

  it("reuses a persisted session only after the current runtime accepts it", async () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    const session = {
      sessionId: "persisted-session",
      csrfToken: "persisted-csrf",
      expiresAt: Date.now() + 120_000,
    };
    persistSession(session, env);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(
      loadOrCreateDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl,
      }),
    ).resolves.toEqual(session);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:31337/api/auth/me",
    );
  });

  it("preserves a persisted session while its runtime is unavailable", async () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    persistSession(
      {
        sessionId: "persisted-session",
        csrfToken: "persisted-csrf",
        expiresAt: Date.now() + 120_000,
      },
      env,
    );

    await expect(
      loadOrCreateDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: async () => new Response("{}", { status: 503 }),
      }),
    ).resolves.toBeNull();
    expect(fs.existsSync(resolveSessionPath(env))).toBe(true);
  });

  it("replaces a runtime-rejected receipt through one socket proof", async () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    persistSession(
      {
        sessionId: "stale-session",
        csrfToken: "stale-csrf",
        expiresAt: Date.now() + 120_000,
      },
      env,
    );
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (fetchImpl.mock.calls.length === 1) {
          return new Response("{}", { status: 401 });
        }
        const body = JSON.parse(String(init?.body)) as { socketPath: string };
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(body.socketPath);
          let proofBytes = 0;
          socket.on("data", (chunk) => {
            proofBytes += chunk.length;
          });
          socket.once("end", () => {
            if (proofBytes === 32) resolve();
            else reject(new Error(`unexpected proof length: ${proofBytes}`));
          });
          socket.once("error", reject);
        });
        return Response.json({
          sessionId: "replacement-session",
          csrfToken: "replacement-csrf",
          expiresAt: Date.now() + 120_000,
        });
      },
    );

    const replacement = await loadOrCreateDesktopSession({
      apiBase: "http://127.0.0.1:31337",
      env,
      fetchImpl,
    });

    expect(replacement?.sessionId).toBe("replacement-session");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(loadPersistedSession(env)?.sessionId).toBe("replacement-session");
  });
});
