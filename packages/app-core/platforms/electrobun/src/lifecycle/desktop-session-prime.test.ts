/** Exercises desktop session prime behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGED_WINDOWS_BOOTSTRAP_PARTITION } from "../main-window-session";
import {
  CSRF_COOKIE_NAME,
  persistSession,
  SESSION_COOKIE_NAME,
} from "../native/auth-bridge";

const authBridgeState = vi.hoisted(() => ({
  loadOrCreateDesktopSession: vi.fn(),
  actualLoad: undefined as
    | undefined
    | ((deps: { apiBase: string }) => Promise<{
        sessionId: string;
        csrfToken: string;
        expiresAt: number;
      } | null>),
}));

type StoredCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  url?: string;
};

const electrobunState = vi.hoisted(() => {
  const defaultCookies: StoredCookie[] = [];
  const partitions = new Map<string, StoredCookie[]>();

  const defaultSet = vi.fn((cookie: StoredCookie): boolean => {
    defaultCookies.push({ ...cookie });
    return true;
  });

  const fromPartition = vi.fn((partition: string) => {
    let bucket = partitions.get(partition);
    if (!bucket) {
      bucket = [];
      partitions.set(partition, bucket);
    }
    const target = bucket;
    return {
      cookies: {
        set: (cookie: StoredCookie): boolean => {
          target.push({ ...cookie });
          return true;
        },
      },
    };
  });

  return {
    defaultCookies,
    partitions,
    defaultSet,
    fromPartition,
    defaultSession: { cookies: { set: defaultSet } },
  };
});

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("electrobun/bun", () => ({
  Session: {
    defaultSession: electrobunState.defaultSession,
    fromPartition: electrobunState.fromPartition,
  },
}));

vi.mock("../native/auth-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native/auth-bridge")>();
  authBridgeState.actualLoad = actual.loadOrCreateDesktopSession;
  authBridgeState.loadOrCreateDesktopSession.mockImplementation(
    actual.loadOrCreateDesktopSession,
  );
  return {
    ...actual,
    loadOrCreateDesktopSession: authBridgeState.loadOrCreateDesktopSession,
  };
});

import { logger } from "../logger";
import {
  markDesktopSessionStale,
  primeDesktopSessionAuth,
} from "./desktop-session-prime";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_DESKTOP_TEST_PARTITION",
  "ELIZA_DESKTOP_TEST_API_BASE",
  "ELIZA_DESKTOP_FORCE_CEF",
] as const;

const LOOPBACK_API = "http://127.0.0.1:31337";
const RENDERER_ORIGIN = "http://127.0.0.1:5173";

const originalEnv = new Map<string, string | undefined>();
const tempRoots: string[] = [];

function createStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-session-prime-"));
  tempRoots.push(dir);
  return dir;
}

function seedPersistedSession(expiresAt = Date.now() + 86_400_000): {
  sessionId: string;
  csrfToken: string;
  expiresAt: number;
} {
  const stateDir = createStateDir();
  const session = {
    sessionId: "desktop-session-id",
    csrfToken: "desktop-csrf-token",
    expiresAt,
  };
  persistSession(session, { ELIZA_STATE_DIR: stateDir });
  process.env.ELIZA_STATE_DIR = stateDir;
  return session;
}

function cookieNames(cookies: StoredCookie[]): string[] {
  return cookies.map((cookie) => cookie.name);
}

describe("desktop-session-prime", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    electrobunState.defaultCookies.length = 0;
    electrobunState.partitions.clear();
    electrobunState.defaultSet.mockReset();
    electrobunState.defaultSet.mockImplementation((cookie: StoredCookie) => {
      electrobunState.defaultCookies.push({ ...cookie });
      return true;
    });
    electrobunState.fromPartition.mockReset();
    electrobunState.fromPartition.mockImplementation((partition: string) => {
      let bucket = electrobunState.partitions.get(partition);
      if (!bucket) {
        bucket = [];
        electrobunState.partitions.set(partition, bucket);
      }
      const target = bucket;
      return {
        cookies: {
          set: (cookie: StoredCookie): boolean => {
            target.push({ ...cookie });
            return true;
          },
        },
      };
    });
    authBridgeState.loadOrCreateDesktopSession.mockReset();
    authBridgeState.loadOrCreateDesktopSession.mockImplementation(
      (deps: { apiBase: string }) => {
        const actualLoad = authBridgeState.actualLoad;
        if (!actualLoad) {
          throw new Error("auth-bridge actual load was not captured");
        }
        return actualLoad(deps);
      },
    );
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
    markDesktopSessionStale();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
    markDesktopSessionStale();
  });

  it("skips the bridge and cookie jar after a successful prime", async () => {
    seedPersistedSession();

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);
    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(1);
    expect(electrobunState.defaultCookies).toHaveLength(2);
  });

  it("re-runs the bridge after markDesktopSessionStale", async () => {
    seedPersistedSession();

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);
    markDesktopSessionStale();
    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
    expect(electrobunState.defaultCookies).toHaveLength(4);
  });

  it("leaves the jar empty and stays unprimed when the bridge produces no session", async () => {
    process.env.ELIZA_STATE_DIR = createStateDir();

    await primeDesktopSessionAuth("https://agent.example.com", RENDERER_ORIGIN);
    await primeDesktopSessionAuth("https://agent.example.com", RENDERER_ORIGIN);

    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledWith({
      apiBase: "https://agent.example.com",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "[Main] Desktop auth bridge produced no session; renderer will use the standard login flow.",
    );
    expect(electrobunState.defaultCookies).toEqual([]);
    expect(electrobunState.fromPartition).not.toHaveBeenCalled();
  });

  it("warns with the Error message when the bridge throws and stays unprimed", async () => {
    authBridgeState.loadOrCreateDesktopSession.mockRejectedValueOnce(
      new Error("disk exploded"),
    );

    await primeDesktopSessionAuth(LOOPBACK_API, RENDERER_ORIGIN);
    await primeDesktopSessionAuth(LOOPBACK_API, RENDERER_ORIGIN);

    expect(logger.warn).toHaveBeenCalledWith(
      "[Main] Desktop auth bridge failed: disk exploded",
    );
    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
    expect(electrobunState.defaultCookies).toEqual([]);
  });

  it("stringifies a non-Error bridge rejection", async () => {
    authBridgeState.loadOrCreateDesktopSession.mockRejectedValueOnce(
      "bridge down",
    );

    await primeDesktopSessionAuth(LOOPBACK_API, RENDERER_ORIGIN);

    expect(logger.warn).toHaveBeenCalledWith(
      "[Main] Desktop auth bridge failed: bridge down",
    );
    expect(electrobunState.defaultCookies).toEqual([]);
  });

  it("installs session and csrf cookies on the default jar when no partition is set", async () => {
    const session = seedPersistedSession(1_800_000_000_000);

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(electrobunState.fromPartition).not.toHaveBeenCalled();
    expect(cookieNames(electrobunState.defaultCookies)).toEqual([
      SESSION_COOKIE_NAME,
      CSRF_COOKIE_NAME,
    ]);
    expect(electrobunState.defaultCookies[0]).toEqual(
      expect.objectContaining({
        name: SESSION_COOKIE_NAME,
        value: session.sessionId,
        domain: "127.0.0.1",
        path: "/",
        secure: false,
        httpOnly: true,
        sameSite: "lax",
        expirationDate: 1_800_000_000,
      }),
    );
    expect(electrobunState.defaultCookies[1]).toEqual(
      expect.objectContaining({
        name: CSRF_COOKIE_NAME,
        value: session.csrfToken,
        domain: "127.0.0.1",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "lax",
        expirationDate: 1_800_000_000,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      `[Main] Desktop loopback session primed on ${LOOPBACK_API}`,
    );
  });

  it("installs cookies on Session.fromPartition when a test partition is set", async () => {
    seedPersistedSession();
    process.env.ELIZA_DESKTOP_TEST_PARTITION = "isolated";

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(electrobunState.fromPartition).toHaveBeenCalledWith(
      "persist:isolated",
    );
    expect(electrobunState.defaultCookies).toEqual([]);
    expect(
      cookieNames(electrobunState.partitions.get("persist:isolated") ?? []),
    ).toEqual([SESSION_COOKIE_NAME, CSRF_COOKIE_NAME]);
  });

  it("prefers ELIZA_DESKTOP_TEST_PARTITION over ELIZA_DESKTOP_TEST_API_BASE", async () => {
    seedPersistedSession();
    process.env.ELIZA_DESKTOP_TEST_PARTITION = "persist:winner";
    process.env.ELIZA_DESKTOP_TEST_API_BASE = LOOPBACK_API;

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(electrobunState.fromPartition).toHaveBeenCalledWith(
      "persist:winner",
    );
    expect(electrobunState.fromPartition).not.toHaveBeenCalledWith(
      PACKAGED_WINDOWS_BOOTSTRAP_PARTITION,
    );
  });

  it("uses the packaged bootstrap partition when only the test API base is set", async () => {
    seedPersistedSession();
    process.env.ELIZA_DESKTOP_TEST_API_BASE = LOOPBACK_API;

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(electrobunState.fromPartition).toHaveBeenCalledWith(
      PACKAGED_WINDOWS_BOOTSTRAP_PARTITION,
    );
  });

  it("installs both origins when the renderer is not the API origin", async () => {
    seedPersistedSession();

    await primeDesktopSessionAuth(LOOPBACK_API, RENDERER_ORIGIN);

    expect(cookieNames(electrobunState.defaultCookies)).toEqual([
      SESSION_COOKIE_NAME,
      CSRF_COOKIE_NAME,
      SESSION_COOKIE_NAME,
      CSRF_COOKIE_NAME,
    ]);
    expect(electrobunState.defaultCookies[0]?.domain).toBe("127.0.0.1");
    expect(electrobunState.defaultCookies[2]?.domain).toBe("127.0.0.1");
    expect(logger.info).toHaveBeenCalledWith(
      `[Main] Desktop loopback session primed on ${LOOPBACK_API}, ${RENDERER_ORIGIN}`,
    );
  });

  it("marks https origins secure and http origins not secure", async () => {
    seedPersistedSession();

    await primeDesktopSessionAuth(
      "https://127.0.0.1:8443",
      "http://127.0.0.1:5173",
    );

    const sessionCookies = electrobunState.defaultCookies.filter(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(sessionCookies[0]).toEqual(
      expect.objectContaining({
        secure: true,
        domain: "127.0.0.1",
      }),
    );
    expect(sessionCookies[1]).toEqual(
      expect.objectContaining({
        secure: false,
        domain: "127.0.0.1",
      }),
    );
  });

  it("logs <no targets> for unparsable origins and still marks the process primed", async () => {
    seedPersistedSession();

    await primeDesktopSessionAuth("not a url", "");
    await primeDesktopSessionAuth("not a url", "");

    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(1);
    expect(electrobunState.defaultCookies).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "[Main] Desktop loopback session primed on <no targets>",
    );
  });

  it("warns and stays unprimed when the cookie jar throws", async () => {
    seedPersistedSession();
    electrobunState.defaultSet.mockImplementation(() => {
      throw new Error("jar locked");
    });

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);
    electrobunState.defaultSet.mockImplementation((cookie: StoredCookie) => {
      electrobunState.defaultCookies.push({ ...cookie });
      return true;
    });
    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(logger.warn).toHaveBeenCalledWith(
      "[Main] Desktop auth cookie install failed: jar locked",
    );
    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
    expect(cookieNames(electrobunState.defaultCookies)).toEqual([
      SESSION_COOKIE_NAME,
      CSRF_COOKIE_NAME,
    ]);
  });

  it("stringifies a non-Error cookie-install throw", async () => {
    seedPersistedSession();
    electrobunState.defaultSet.mockImplementation(() => {
      throw 42;
    });

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(logger.warn).toHaveBeenCalledWith(
      "[Main] Desktop auth cookie install failed: 42",
    );
  });

  it("warns and stays unprimed when Session.fromPartition throws", async () => {
    seedPersistedSession();
    process.env.ELIZA_DESKTOP_TEST_PARTITION = "broken";
    electrobunState.fromPartition.mockImplementation(() => {
      throw new Error("no such partition");
    });

    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);
    await primeDesktopSessionAuth(LOOPBACK_API, LOOPBACK_API);

    expect(logger.warn).toHaveBeenCalledWith(
      "[Main] Desktop auth cookie install failed: no such partition",
    );
    expect(authBridgeState.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
    expect(electrobunState.defaultCookies).toEqual([]);
  });
});
