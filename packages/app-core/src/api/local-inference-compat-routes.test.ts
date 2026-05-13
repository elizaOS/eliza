import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

// ── mocks ──────────────────────────────────────────────────────────────

const setActiveMock = vi.fn();

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    ModelType: {
      TEXT_LARGE: "TEXT_LARGE",
      TEXT_SMALL: "TEXT_SMALL",
      TEXT_EMBEDDING: "TEXT_EMBEDDING",
      TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
      TRANSCRIPTION: "TRANSCRIPTION",
    },
    ResponseSkeletonStreamExtractor: class {
      done = false;
      push(chunk: string) {
        return chunk;
      }
      flush() {
        this.done = true;
        return "";
      }
      reset() {
        this.done = false;
      }
    },
    stringToUuid: (value: string) => value,
  };
});

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
    ensureCompatSensitiveRouteAuthorized: () => true,
    getCompatApiToken: () => null,
    getProvidedApiToken: () => null,
    tokenMatches: () => true,
  };
});

vi.mock("./auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth/sessions")>();
  return {
    ...actual,
    findActiveSession: vi.fn(async () => null),
    parseSessionCookie: vi.fn(() => null),
  };
});

vi.mock("./server-onboarding-helpers", () => ({
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
      modelId: "eliza-1-1_7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    const handled = await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: { modelId: "eliza-1-1_7b" },
      }),
      res.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith(null, "eliza-1-1_7b", undefined);
  });

  it("forwards a parsed overrides block to setActive", async () => {
    setActiveMock.mockResolvedValue({
      modelId: "eliza-1-1_7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "eliza-1-1_7b",
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
    expect(setActiveMock).toHaveBeenCalledWith(null, "eliza-1-1_7b", {
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
          modelId: "eliza-1-1_7b",
          overrides: { cacheTypeK: "tbq4_0" },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(400);
    const { error } = res.body() as { error: string };
    expect(error).toContain('cacheTypeK="tbq4_0"');
    expect(error).toMatch(/elizaOS\/llama\.cpp kernel/i);
    expect(error).toContain("Stock-only types accepted here:");
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("rejects illegal contextSize", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "eliza-1-1_7b",
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
          modelId: "eliza-1-1_7b",
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
      modelId: "eliza-1-1_7b",
      loadedAt: "2026-05-09T00:00:00.000Z",
      status: "ready",
    });

    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: {
          modelId: "eliza-1-1_7b",
          overrides: { kvOffload: { gpuLayers: 16 } },
        },
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith(null, "eliza-1-1_7b", {
      kvOffload: { gpuLayers: 16 },
    });
  });

  it("rejects an overrides field that isn't an object", async () => {
    const res = fakeRes();
    await handleLocalInferenceCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/local-inference/active",
        body: { modelId: "eliza-1-1_7b", overrides: "nope" },
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
