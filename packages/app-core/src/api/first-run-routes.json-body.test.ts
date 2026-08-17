/**
 * Untrusted JSON body contract for app-core `POST /api/first-run`.
 *
 * The handler is the onboarding submit path. Syntax errors and non-object
 * bodies are client garbage and must be HTTP 400, not a fabricated
 * `{ ok: true }`. Valid objects keep today's persist-then-200 behavior.
 * Deterministic handler tests against the real `handleFirstRunRoute`.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const saveElizaConfig = vi.fn();

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/agent", () => ({
  applyCanonicalFirstRunConfig: vi.fn(),
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig,
}));

vi.mock("@elizaos/shared", () => ({
  getCloudSecret: () => undefined,
  migrateLegacyRuntimeConfig: vi.fn(),
  normalizeDeploymentTargetConfig: () => undefined,
  normalizeFirstRunProviderId: () => null,
  normalizeLinkedAccountFlagsConfig: () => undefined,
  normalizeServiceRoutingConfig: () => undefined,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

vi.mock("./compat-route-shared", () => ({
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
  extractAndPersistFirstRunApiKey: vi.fn(),
  hasDeprecatedFirstRunRequestFields: () => false,
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
    url: pathname,
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
  return sink as http.ServerResponse & { jsonBody: () => unknown };
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

  it("still persists a canonical object body", async () => {
    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toEqual({ ok: true });
    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
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
