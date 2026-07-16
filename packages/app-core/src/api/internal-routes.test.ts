/**
 * Unit tests for the `POST /api/internal/wake` handler and `getDeviceSecret`,
 * driving fake req/res objects. Covers device-secret bearer auth (401s), wake
 * body validation, the happy path (runDueTasks fired, telemetry mirrored),
 * runtime / task-service unavailability, error capture, deadline→maxWallTimeMs
 * clamping, routing pass-through, and on-disk device-secret persistence + mode.
 */
import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  __resetWakeTelemetryForTests,
  __setDeviceSecretForTests,
  __setDeviceSecretPathForTests,
  getDeviceSecret,
  getWakeTelemetry,
  handleInternalWakeRoute,
} from "./internal-routes";

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(
  pathname: string,
  options: {
    method?: string;
    auth?: string;
    body?: Record<string, unknown>;
  } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method ?? "POST";
  req.url = pathname;
  req.headers = { host: "127.0.0.1:31337" };
  if (options.auth !== undefined) {
    req.headers.authorization = options.auth;
  }
  if (options.body !== undefined) {
    (req as { body?: unknown }).body = options.body;
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function stateWithTaskService(service: unknown): CompatRuntimeState {
  return {
    current: {
      getService: () => service,
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

describe("POST /api/internal/wake — auth", () => {
  beforeEach(() => {
    __setDeviceSecretForTests(SECRET);
    __resetWakeTelemetryForTests();
  });

  it("returns 401 with no authorization header", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns 401 with a wrong bearer secret", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: "Bearer wrong-secret",
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
  });

  it("returns 401 with a non-Bearer scheme", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Token ${SECRET}`,
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
  });
});

describe("POST /api/internal/wake — body validation", () => {
  beforeEach(() => {
    __setDeviceSecretForTests(SECRET);
    __resetWakeTelemetryForTests();
  });

  it("rejects invalid kind", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "bogus", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(400);
  });

  it("rejects non-number deadlineMs", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs: "soon" },
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(400);
  });
});

describe("POST /api/internal/wake — happy path", () => {
  beforeEach(() => {
    __setDeviceSecretForTests(SECRET);
    __resetWakeTelemetryForTests();
  });

  it("triggers runDueTasks and returns durationMs/lastWakeFiredAt", async () => {
    const runDueTasks = vi.fn(async () => {});
    const res = fakeRes();
    const before = Date.now();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );
    expect(handled).toBe(true);
    expect(runDueTasks).toHaveBeenCalledTimes(1);
    expect(res.status()).toBe(200);
    const body = res.body() as {
      ok: boolean;
      durationMs: number;
      lastWakeFiredAt: number;
      coalesced: boolean;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.durationMs).toBe("number");
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.lastWakeFiredAt).toBeGreaterThanOrEqual(before);
    expect(body.coalesced).toBe(false);

    // Telemetry mirrors the response so /api/health can read it.
    const telemetry = getWakeTelemetry();
    expect(telemetry.lastWakeFiredAt).toBe(body.lastWakeFiredAt);
    expect(telemetry.lastWakeKind).toBe("refresh");
    expect(telemetry.lastWakeError).toBe(null);
  });

  it("returns 503 when runtime is not initialized", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      {
        current: null,
        pendingAgentName: null,
        pendingRestartReasons: [],
      },
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({ ok: false, error: "runtime_unavailable" });
  });

  it("returns 503 when no TaskService is registered", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService(null),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      ok: false,
      error: "task_service_unavailable",
    });
  });

  it("records lastWakeError on runDueTasks failure", async () => {
    const runDueTasks = vi.fn(async () => {
      throw new Error("task explode");
    });
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "processing", deadlineMs: Date.now() + 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(500);
    expect(getWakeTelemetry().lastWakeError).toBe("task explode");
    expect(getWakeTelemetry().lastWakeKind).toBe("processing");
  });

  it("passes maxWallTimeMs derived from deadlineMs to runDueTasks", async () => {
    const calls: Array<{ maxWallTimeMs?: number }> = [];
    const runDueTasks = vi.fn(
      async (options: { maxWallTimeMs?: number } = {}) => {
        calls.push(options);
      },
    );
    const res = fakeRes();
    const deadlineMs = Date.now() + 10_000;
    await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs },
      }),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );
    expect(calls.length).toBe(1);
    const passed = calls[0].maxWallTimeMs;
    expect(typeof passed).toBe("number");
    if (typeof passed !== "number") return;
    expect(passed).toBeGreaterThan(0);
    // Should be at most the original window.
    expect(passed).toBeLessThanOrEqual(10_000);
  });

  it("clamps an already-expired deadline to a 1s floor", async () => {
    const calls: Array<{ maxWallTimeMs?: number }> = [];
    const runDueTasks = vi.fn(
      async (options: { maxWallTimeMs?: number } = {}) => {
        calls.push(options);
      },
    );
    const res = fakeRes();
    await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        auth: `Bearer ${SECRET}`,
        body: { kind: "refresh", deadlineMs: Date.now() - 5000 },
      }),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );
    expect(calls[0].maxWallTimeMs).toBe(1000);
  });
});

describe("POST /api/internal/wake — routing", () => {
  beforeEach(() => {
    __setDeviceSecretForTests(SECRET);
    __resetWakeTelemetryForTests();
  });

  it("leaves unrelated paths unhandled", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/something-else", {
        auth: `Bearer ${SECRET}`,
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(false);
  });

  it("leaves non-POST methods unhandled", async () => {
    const res = fakeRes();
    const handled = await handleInternalWakeRoute(
      fakeReq("/api/internal/wake", {
        method: "GET",
        auth: `Bearer ${SECRET}`,
      }),
      res.res,
      stateWithTaskService({ runDueTasks: vi.fn() }),
    );
    expect(handled).toBe(false);
  });
});

describe("getDeviceSecret", () => {
  beforeEach(() => {
    __setDeviceSecretPathForTests(null);
  });

  it("returns a stable value across calls within a process", () => {
    __setDeviceSecretForTests(null);
    const a = getDeviceSecret();
    const b = getDeviceSecret();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("honours ELIZA_DEVICE_SECRET when set with sufficient entropy", () => {
    __setDeviceSecretForTests(null);
    const previous = process.env.ELIZA_DEVICE_SECRET;
    process.env.ELIZA_DEVICE_SECRET = "configured-device-secret-value-min-16";
    try {
      const secret = getDeviceSecret();
      expect(secret).toBe("configured-device-secret-value-min-16");
    } finally {
      if (previous === undefined) {
        delete process.env.ELIZA_DEVICE_SECRET;
      } else {
        process.env.ELIZA_DEVICE_SECRET = previous;
      }
      __setDeviceSecretForTests(null);
    }
  });

  it("delegates account-pool broker routes before wake handling", async () => {
    const previousEnabled = process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
    const previousSecret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
    process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = "1";
    process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET =
      "test-broker-secret-at-least-thirty-two-chars";
    try {
      const response = fakeRes();
      const handled = await handleInternalWakeRoute(
        fakeReq("/internal/account-pool/v1/health", {
          method: "GET",
          auth: "Bearer test-broker-secret-at-least-thirty-two-chars",
        }),
        response.res,
        {
          current: null,
          pendingAgentName: null,
          pendingRestartReasons: [],
        },
      );
      expect(handled).toBe(true);
      expect(response.status()).toBe(200);
      expect(response.body()).toMatchObject({ ok: true });
    } finally {
      if (previousEnabled === undefined)
        delete process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
      else process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = previousEnabled;
      if (previousSecret === undefined)
        delete process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
      else process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = previousSecret;
    }
  });

  it("persists generated secrets across cache resets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-device-secret-"));
    const filePath = path.join(dir, "state", "internal", "device-secret");
    __setDeviceSecretPathForTests(filePath);
    try {
      const first = getDeviceSecret();
      __setDeviceSecretForTests(null);
      const second = getDeviceSecret();
      expect(second).toBe(first);
      expect(fs.readFileSync(filePath, "utf8").trim()).toBe(first);
      // NTFS doesn't model the Unix permission bits and Node's
      // `fs.chmodSync` only sets the read-only flag on Windows, so the
      // POSIX `0o600` assertion can't hold there. The implementation still
      // calls chmod; on POSIX it's enforced, on Windows the file-system
      // ACL governs access instead.
      if (process.platform !== "win32") {
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      __setDeviceSecretPathForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
