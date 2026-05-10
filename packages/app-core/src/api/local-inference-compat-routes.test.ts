import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

// ── mocks ──────────────────────────────────────────────────────────────

const setActiveMock = vi.fn();

vi.mock("@elizaos/core", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  stringToUuid: (value: string) => value,
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/shared", () => ({
  isLoopbackBindHost: () => true,
  normalizeOnboardingProviderId: (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  resolveApiToken: () => null,
  resolveDeploymentTargetInConfig: () => ({}),
  resolveServiceRoutingInConfig: () => ({}),
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  ensureCompatSensitiveRouteAuthorized: () => true,
  getCompatApiToken: () => null,
  getProvidedApiToken: () => null,
  tokenMatches: () => true,
}));

vi.mock("./auth/sessions", () => ({
  findActiveSession: vi.fn(async () => null),
  parseSessionCookie: vi.fn(() => null),
}));

vi.mock("./server-onboarding-compat", () => ({
  isCloudProvisioned: () => false,
}));

vi.mock("../services/local-inference/service", () => ({
  localInferenceService: {
    setActive: setActiveMock,
    getActive: () => ({ modelId: null, loadedAt: null, status: "idle" }),
    clearActive: vi.fn(async () => ({
      modelId: null,
      loadedAt: null,
      status: "idle",
    })),
    getCatalog: () => [],
    snapshot: vi.fn(),
    getInstalled: vi.fn(),
    getHardware: vi.fn(),
    getDownloads: () => [],
    getAssignments: vi.fn(),
    getTextReadiness: vi.fn(),
    setSlotAssignment: vi.fn(),
    startDownload: vi.fn(),
    cancelDownload: vi.fn(),
    subscribeDownloads: vi.fn(),
    subscribeActive: vi.fn(),
    searchHuggingFace: vi.fn(),
    verifyModel: vi.fn(),
    uninstall: vi.fn(),
    getRecommendedModel: vi.fn(),
    getRecommendedModels: vi.fn(),
    startSmallerFallbackDownload: vi.fn(),
    getLocalCacheStats: vi.fn(),
  },
}));

vi.mock("../services/local-inference/device-bridge", () => ({
  deviceBridge: { status: () => ({ connected: false, devices: [] }) },
}));

vi.mock("../services/local-inference/handler-registry", () => ({
  handlerRegistry: { getAll: () => [] },
  toPublicRegistration: (r: unknown) => r,
}));

vi.mock("../services/local-inference/providers", () => ({
  snapshotProviders: vi.fn(async () => []),
}));

vi.mock("../services/local-inference/routing-preferences", () => ({
  readRoutingPreferences: vi.fn(async () => ({})),
  setPolicy: vi.fn(),
  setPreferredProvider: vi.fn(),
}));

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

// ── test helpers ───────────────────────────────────────────────────────

let handleLocalInferenceCompatRoutes: typeof import("./local-inference-compat-routes").handleLocalInferenceCompatRoutes;

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

function fakeReq(opts: {
  method: string;
  pathname: string;
  body?: unknown;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = { host: "localhost:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  if (opts.body !== undefined) {
    (req as { body?: unknown }).body = opts.body;
  }
  return req;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("POST /api/local-inference/active", () => {
  beforeAll(async () => {
    handleLocalInferenceCompatRoutes = (
      await import("./local-inference-compat-routes")
    ).handleLocalInferenceCompatRoutes;
  });

  afterEach(() => {
    setActiveMock.mockReset();
  });

  it("accepts the legacy { modelId } body shape (no overrides)", async () => {
    setActiveMock.mockResolvedValue({
      modelId: "qwen2.5-coder-7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    const handled = await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: { modelId: "qwen2.5-coder-7b" },
      }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith(
      null,
      "qwen2.5-coder-7b",
      undefined,
    );
  });

  it("forwards a parsed overrides block to setActive", async () => {
    setActiveMock.mockResolvedValue({
      modelId: "qwen2.5-coder-7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "qwen2.5-coder-7b",
          overrides: {
            contextSize: 131072,
            cacheTypeK: "f16",
            cacheTypeV: "q8_0",
            gpuLayers: 32,
            flashAttention: true,
          },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith(null, "qwen2.5-coder-7b", {
      contextSize: 131072,
      cacheTypeK: "f16",
      cacheTypeV: "q8_0",
      gpuLayers: 32,
      flashAttention: true,
    });
  });

  it("rejects fork-only KV cache types from desktop callers", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "bonsai-8b-1bit",
          overrides: { cacheTypeK: "tbq4_0" },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(400);
    expect((res.body() as { error: string }).error).toMatch(/apothic|fork/i);
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("rejects illegal contextSize", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "qwen2.5-coder-7b",
          overrides: { contextSize: 100 },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(400);
    expect((res.body() as { error: string }).error).toMatch(/contextSize/);
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("rejects illegal kvOffload values", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "qwen2.5-coder-7b",
          overrides: { kvOffload: "magic" },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(400);
    expect((res.body() as { error: string }).error).toMatch(/kvOffload/);
  });

  it("accepts kvOffload object form { gpuLayers: N }", async () => {
    setActiveMock.mockResolvedValue({
      modelId: "qwen2.5-coder-7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "qwen2.5-coder-7b",
          overrides: { kvOffload: { gpuLayers: 16 } },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith(null, "qwen2.5-coder-7b", {
      kvOffload: { gpuLayers: 16 },
    });
  });

  it("rejects an overrides field that isn't an object", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: { modelId: "qwen2.5-coder-7b", overrides: "nope" },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(400);
    expect((res.body() as { error: string }).error).toMatch(
      /overrides must be an object/,
    );
  });
});
