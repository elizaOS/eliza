/**
 * Untrusted JSON body contract for app-core `POST /api/first-run`.
 *
 * The handler is the onboarding submit path. Syntax errors and non-object
 * bodies are client garbage and must be HTTP 400, not a fabricated
 * `{ ok: true }`.
 *
 * The host rejects unauthorized, malformed, and oversized requests before the
 * canonical agent writer. Accepted object bodies are cached byte-for-byte so
 * the downstream writer receives the original transport payload unchanged.
 * Deterministic handler tests against the real `handleFirstRunRoute`.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const saveElizaConfig = vi.fn();
const extractAndPersistFirstRunApiKey = vi.fn();
const readRequestBody = vi.fn(
  async (
    req: http.IncomingMessage,
    options: { maxBytes?: number; returnNullOnTooLarge?: boolean },
  ) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        if (options.returnNullOnTooLarge) return null;
        throw new Error("Request body too large");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
);

const CACHED_REQUEST_BODY = Symbol.for("eliza.http.cachedRequestBody");
const readRequestBodyBuffer = vi.fn(
  async (
    req: http.IncomingMessage,
    options: { maxBytes?: number; returnNullOnTooLarge?: boolean } = {},
  ): Promise<Buffer | null> => {
    const cached = (
      req as http.IncomingMessage & { [CACHED_REQUEST_BODY]?: Buffer }
    )[CACHED_REQUEST_BODY];
    if (cached) {
      return cached.length > (options.maxBytes ?? Number.POSITIVE_INFINITY)
        ? null
        : cached;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        if (options.returnNullOnTooLarge) return null;
        throw new Error("Request body too large");
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    (req as http.IncomingMessage & { [CACHED_REQUEST_BODY]?: Buffer })[
      CACHED_REQUEST_BODY
    ] = body;
    return body;
  },
);

const loadElizaConfig = vi.fn(() => ({}));
const hasPersistedFirstRunState = vi.fn(() => false);
const ensureRouteMinRole = vi.fn(async () => true);

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  readRequestBody,
  readRequestBodyBuffer,
}));

vi.mock("@elizaos/agent", () => ({
  applyCanonicalFirstRunConfig: vi.fn(),
  hasPresentedAuthCredential: () => false,
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig,
}));

vi.mock("@elizaos/agent/config/config", () => ({ loadElizaConfig }));
vi.mock("@elizaos/agent/api/server-helpers", () => ({
  hasPersistedFirstRunState,
}));
vi.mock("@elizaos/agent/api/server-helpers-auth", () => ({
  hasPresentedAuthCredential: () => false,
}));

vi.mock("@elizaos/shared", () => ({
  getCloudSecret: () => undefined,
  isLoopbackRemoteAddress: vi.fn(),
  isTrustedLocalRequest: vi.fn(),
  migrateLegacyRuntimeConfig: vi.fn(),
  normalizeDeploymentTargetConfig: () => undefined,
  normalizeFirstRunProviderId: () => null,
  normalizeLinkedAccountFlagsConfig: () => undefined,
  normalizeServiceRoutingConfig: () => undefined,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  ensureRouteMinRole,
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  ensureRouteMinRole,
}));

vi.mock("./compat-route-shared", () => ({
  getConfiguredCompatAgentName: () => "Eliza",
  hasCompatPersistedFirstRunState: () => false,
}));

vi.mock("./deferred-runtime-boot", () => ({
  isRuntimeBootDeferred: () => false,
  triggerDeferredRuntimeBoot: vi.fn(),
}));

vi.mock("./server-first-run-helpers", () => ({
  deriveFirstRunReplayBody: (body: Record<string, unknown>) => ({
    replayBody: body,
  }),
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields: () => false,
  isCloudProvisioned: () => false,
  persistFirstRunDefaults: vi.fn(),
}));

function requestWithRawBody(
  raw: string,
  pathname = "/api/first-run",
): http.IncomingMessage {
  const stream = Readable.from(
    raw.length === 0 ? [] : [Buffer.from(raw, "utf8")],
  );
  return Object.assign(stream, {
    headers: { "content-type": "application/json" },
    method: "POST",
    socket: { localPort: undefined },
    url: pathname,
  }) as unknown as http.IncomingMessage;
}

function requestWithChunks(chunks: readonly Buffer[]): http.IncomingMessage {
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    headers: { "content-type": "application/json" },
    method: "POST",
    socket: { localPort: undefined, remoteAddress: "127.0.0.1" },
    url: "/api/first-run",
  }) as unknown as http.IncomingMessage;
}

function responseSink(): http.ServerResponse & {
  jsonBody: () => unknown;
} {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => sink,
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return {} as http.ServerResponse;
    },
    jsonBody: () => (body ? JSON.parse(body) : undefined),
  };
  return sink as unknown as http.ServerResponse & { jsonBody: () => unknown };
}

function emptyState(): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

async function postFirstRun(raw: string) {
  const { handleFirstRunRoute } = await import("./first-run-routes");
  const res = responseSink();
  const handled = await handleFirstRunRoute(
    requestWithRawBody(raw),
    res,
    emptyState(),
  );
  return { handled, res };
}

describe("POST /api/first-run JSON body", () => {
  beforeEach(() => {
    saveElizaConfig.mockReset();
    extractAndPersistFirstRunApiKey.mockReset();
    loadElizaConfig.mockReset().mockReturnValue({});
    hasPersistedFirstRunState.mockReset().mockReturnValue(false);
    ensureRouteMinRole.mockReset().mockResolvedValue(true);
  });

  it.each(["", "   ", "{", "not-json", "[]", "null", '"foo"', "42", "true"])(
    "rejects malformed first-run body %j with 400",
    async (raw) => {
      const { handled, res } = await postFirstRun(raw);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.jsonBody()).toEqual({ error: "Invalid JSON body" });
      expect(saveElizaConfig).not.toHaveBeenCalled();
    },
  );

  it("delegates a canonical object body without persisting in app-core", async () => {
    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toBeUndefined();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 413 before persisting", async () => {
    const { MAX_FIRST_RUN_BODY_BYTES } = await import("./first-run-routes");
    const req = requestWithRawBody("x".repeat(MAX_FIRST_RUN_BODY_BYTES + 1));
    const res = responseSink();
    const { handleFirstRunRoute } = await import("./first-run-routes");

    const handled = await handleFirstRunRoute(req, res, emptyState());

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(res.jsonBody()).toEqual({ error: "Request body too large" });
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("does not run the retired app-core config commit", async () => {
    saveElizaConfig.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toBeUndefined();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("does not run retired app-core pre-commit helpers", async () => {
    extractAndPersistFirstRunApiKey.mockRejectedValueOnce(
      new Error("sealed secret unavailable"),
    );

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toBeUndefined();
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(extractAndPersistFirstRunApiKey).not.toHaveBeenCalled();
  });

  it("fails closed when durable onboarding state cannot be read", async () => {
    loadElizaConfig.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody()).toEqual({ error: "First-run setup is unavailable" });
  });

  it("rejects rerun after canonical durable completion", async () => {
    hasPersistedFirstRunState.mockReturnValueOnce(true);

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.jsonBody()).toEqual({
      error: "First-run setup is already complete",
    });
  });

  it("rejects non-OWNER callers before durable-state or body access", async () => {
    ensureRouteMinRole.mockResolvedValueOnce(false);
    const req = requestWithRawBody('{"name":"Eliza"}');
    const res = responseSink();
    const { handleFirstRunRoute } = await import("./first-run-routes");

    const handled = await handleFirstRunRoute(req, res, emptyState());

    expect(handled).toBe(true);
    expect(loadElizaConfig).not.toHaveBeenCalled();
    expect(req.readableEnded).toBe(false);
  });

  it("caches a composed boundary body and preserves every accepted byte", async () => {
    const { MAX_FIRST_RUN_BODY_BYTES, handleFirstRunRoute } = await import(
      "./first-run-routes"
    );
    const prefix = Buffer.from('{\n  "name": "Eliza"\n}');
    const raw = Buffer.concat([
      prefix,
      Buffer.alloc(MAX_FIRST_RUN_BODY_BYTES - prefix.length, 0x20),
    ]);
    expect(raw.length).toBe(MAX_FIRST_RUN_BODY_BYTES);
    const req = requestWithChunks([
      raw.subarray(0, 7),
      raw.subarray(7, 19),
      raw.subarray(19),
    ]);
    const res = responseSink();

    const handled = await handleFirstRunRoute(req, res, emptyState());

    expect(handled).toBe(false);
    expect(await readRequestBodyBuffer(req)).toEqual(raw);
  });

  it("rejects malformed JSON split across transport chunks", async () => {
    const { handleFirstRunRoute } = await import("./first-run-routes");
    const req = requestWithChunks([
      Buffer.from('{"name"'),
      Buffer.from(":"),
      Buffer.from("}"),
    ]);
    const res = responseSink();

    const handled = await handleFirstRunRoute(req, res, emptyState());

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("ignores non-first-run paths", async () => {
    const { handleFirstRunRoute } = await import("./first-run-routes");
    const res = responseSink();
    const handled = await handleFirstRunRoute(
      requestWithRawBody("{}", "/api/other"),
      res,
      emptyState(),
    );
    expect(handled).toBe(false);
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });
});
