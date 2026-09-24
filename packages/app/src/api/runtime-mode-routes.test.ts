/**
 * Unit tests for `handleRuntimeModeRoute` (`GET /api/runtime/mode`). Drives
 * real Node `IncomingMessage`/`ServerResponse` objects through the real
 * handler, `sendJson`/`sendJsonError`, and `ensureRouteAuthorized`. The disk
 * snapshot is a controllable collaborator so mapping, default, and
 * credential-omission branches do not depend on local `eliza.json`.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthRateLimiter } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleRuntimeModeRoute } from "./runtime-mode-routes";

const mocks = vi.hoisted(() => ({
  getRuntimeModeSnapshot: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  getRuntimeModeSnapshot: mocks.getRuntimeModeSnapshot,
}));

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "NODE_ENV",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prior = savedEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

function clearAuthEnv(): void {
  for (const key of ENV_KEYS) {
    if (key === "NODE_ENV") continue;
    delete process.env[key];
  }
}

interface Snapshot {
  mode: string;
  deploymentTarget?: { runtime?: string } | null;
  remoteApiBase?: string | null;
  remoteAccessToken?: string | null;
  remoteApiBaseError?: string | null;
}

interface FakeRes {
  body(): unknown;
  res: http.ServerResponse;
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
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    res,
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(
  pathname: string,
  options: {
    forwardedFor?: string;
    host?: string;
    method?: string;
    omitMethod?: boolean;
    omitUrl?: boolean;
    remoteAddress?: string | null;
  } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  if (!options.omitMethod) {
    req.method = options.method ?? "GET";
  }
  if (!options.omitUrl) {
    req.url = pathname;
  }
  req.headers = { host: options.host ?? "localhost:2138" };
  if (options.forwardedFor !== undefined) {
    req.headers["x-forwarded-for"] = options.forwardedFor;
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value:
      options.remoteAddress === undefined ? "127.0.0.1" : options.remoteAddress,
    configurable: true,
  });
  return req;
}

function stubSnapshot(snapshot: Snapshot): void {
  mocks.getRuntimeModeSnapshot.mockReturnValue(snapshot);
}

const PUBLIC_KEYS = [
  "deploymentRuntime",
  "isRemoteController",
  "mode",
  "remoteApiBaseConfigured",
] as const;

beforeEach(() => {
  snapshotEnv();
  clearAuthEnv();
  _resetAuthRateLimiter();
  mocks.getRuntimeModeSnapshot.mockReset();
  stubSnapshot({
    mode: "local",
    deploymentTarget: { runtime: "local" },
    remoteApiBase: null,
    remoteAccessToken: "must-not-leak",
    remoteApiBaseError: "stale-target",
  });
});

afterEach(() => {
  _resetAuthRateLimiter();
  restoreEnv();
});

describe("handleRuntimeModeRoute routing", () => {
  it("returns false for paths outside /api/runtime/mode without reading the snapshot", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime"),
      res.res,
      STATE,
    );

    expect(handled).toBe(false);
    expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
    expect(res.body()).toBeNull();
  });

  it("returns false when url is missing so the default pathname is /", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime/mode", { omitUrl: true }),
      res.res,
      STATE,
    );

    expect(handled).toBe(false);
    expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
  });

  it("returns false for prefix, trailing-slash, and nearby path variants", async () => {
    const paths = [
      "/api/runtime/mode/",
      "/api/runtime/mode/extra",
      "/api/runtime/modes",
      "/api/runtime/mode-status",
      "/runtime/mode",
    ];

    for (const pathname of paths) {
      const res = fakeRes();
      const handled = await handleRuntimeModeRoute(
        fakeReq(pathname),
        res.res,
        STATE,
      );
      expect(handled).toBe(false);
      expect(res.body()).toBeNull();
    }

    expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
  });
});

describe("handleRuntimeModeRoute methods", () => {
  it.each([
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "post",
  ] as const)(
    "claims %s /api/runtime/mode with 405 before auth or snapshot",
    async (method) => {
      const res = fakeRes();
      const handled = await handleRuntimeModeRoute(
        fakeReq("/api/runtime/mode", {
          method,
          remoteAddress: "203.0.113.9",
          forwardedFor: "203.0.113.9",
        }),
        res.res,
        STATE,
      );

      expect(handled).toBe(true);
      expect(res.status()).toBe(405);
      expect(res.body()).toEqual({ error: "Method not allowed" });
      expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
    },
  );
});

describe("handleRuntimeModeRoute authorization", () => {
  it("claims GET /api/runtime/mode when a remote caller is unauthorized", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime/mode", {
        remoteAddress: "203.0.113.9",
        forwardedFor: "203.0.113.9",
      }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({ error: "Unauthorized" });
    expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a loopback request with a spoofed X-Forwarded-For", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime/mode", { forwardedFor: "203.0.113.9" }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
    expect(mocks.getRuntimeModeSnapshot).not.toHaveBeenCalled();
  });
});

describe("GET /api/runtime/mode", () => {
  it("treats a missing method as GET and serves the snapshot payload", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime/mode", { omitMethod: true }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("uppercases a lowercase GET and honours a query string on the mode path", async () => {
    const res = fakeRes();
    const handled = await handleRuntimeModeRoute(
      fakeReq("/api/runtime/mode?source=shell", { method: "get" }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("omits remoteApiBase, remoteAccessToken, and other snapshot secrets", async () => {
    stubSnapshot({
      mode: "remote",
      deploymentTarget: { runtime: "remote" },
      remoteApiBase: "http://127.0.0.1:2138",
      remoteAccessToken: "controller-secret",
      remoteApiBaseError: "ignored",
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    const body = res.body() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
    expect(body).not.toHaveProperty("remoteApiBase");
    expect(body).not.toHaveProperty("remoteAccessToken");
    expect(body).not.toHaveProperty("remoteApiBaseError");
    expect(body).not.toHaveProperty("deploymentTarget");
  });

  it("defaults deploymentRuntime to local when deploymentTarget is missing", async () => {
    stubSnapshot({
      mode: "local",
      deploymentTarget: null,
      remoteApiBase: null,
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("defaults deploymentRuntime to local when deploymentTarget has no runtime", async () => {
    stubSnapshot({
      mode: "local-only",
      deploymentTarget: {},
      remoteApiBase: null,
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "local-only",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("copies deploymentTarget.runtime for cloud even when mode is not remote", async () => {
    stubSnapshot({
      mode: "cloud",
      deploymentTarget: { runtime: "cloud" },
      remoteApiBase: null,
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("sets isRemoteController from mode === remote, not from deploymentTarget.runtime", async () => {
    stubSnapshot({
      mode: "local",
      deploymentTarget: { runtime: "remote" },
      remoteApiBase: "http://10.0.0.2:3000",
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "local",
      deploymentRuntime: "remote",
      isRemoteController: false,
      remoteApiBaseConfigured: true,
    });
  });

  it("marks a remote controller without exposing the configured base", async () => {
    stubSnapshot({
      mode: "remote",
      deploymentTarget: { runtime: "remote" },
      remoteApiBase: "http://192.168.1.10:2138/",
      remoteAccessToken: "tok",
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "remote",
      deploymentRuntime: "remote",
      isRemoteController: true,
      remoteApiBaseConfigured: true,
    });
  });

  it("treats an empty-string remoteApiBase as not configured", async () => {
    stubSnapshot({
      mode: "remote",
      deploymentTarget: { runtime: "remote" },
      remoteApiBase: "",
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "remote",
      deploymentRuntime: "remote",
      isRemoteController: true,
      remoteApiBaseConfigured: false,
    });
  });

  it("treats whitespace-only remoteApiBase as configured because Boolean does not trim", async () => {
    stubSnapshot({
      mode: "remote",
      deploymentTarget: { runtime: "remote" },
      remoteApiBase: "   ",
    });
    const res = fakeRes();

    await handleRuntimeModeRoute(fakeReq("/api/runtime/mode"), res.res, STATE);

    expect(res.body()).toEqual({
      mode: "remote",
      deploymentRuntime: "remote",
      isRemoteController: true,
      remoteApiBaseConfigured: true,
    });
  });
});
