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
const loadElizaConfig = vi.fn(() => ({}) as Record<string, unknown>);
const loadEffectiveElizaConfig = vi.fn(() => ({}) as Record<string, unknown>);
const extractAndPersistFirstRunApiKey = vi.fn();
const getCloudSecret = vi.fn(() => undefined as string | undefined);
const normalizeLinkedAccountFlagsConfig = vi.fn(() => undefined as unknown);
const resolveDevCloudEnvAuthority = vi.fn(() => null as string | null);
const resolveDevCloudAuthorityEnvValue = vi.fn(
  (key: string) => process.env[key],
);
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

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  readRequestBody,
}));

vi.mock("@elizaos/agent", () => ({
  applyCanonicalFirstRunConfig: vi.fn(),
  loadEffectiveElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
}));

vi.mock("@elizaos/shared", () => ({
  getCloudSecret,
  migrateLegacyRuntimeConfig: vi.fn(),
  normalizeDeploymentTargetConfig: () => undefined,
  normalizeFirstRunProviderId: () => null,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig: () => undefined,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
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
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields: () => false,
  persistFirstRunDefaults: vi.fn(),
}));

function requestWithRawBody(
  raw: string,
  pathname = "/api/first-run",
  localPort?: number,
): http.IncomingMessage {
  const stream = Readable.from(
    raw.length === 0 ? [] : [Buffer.from(raw, "utf8")],
  );
  return Object.assign(stream, {
    headers: { "content-type": "application/json" },
    method: "POST",
    socket: { localPort },
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
    loadElizaConfig.mockReset();
    loadElizaConfig.mockReturnValue({});
    loadEffectiveElizaConfig.mockReset();
    loadEffectiveElizaConfig.mockReturnValue({});
    extractAndPersistFirstRunApiKey.mockReset();
    getCloudSecret.mockReset();
    getCloudSecret.mockReturnValue(undefined);
    normalizeLinkedAccountFlagsConfig.mockReset();
    normalizeLinkedAccountFlagsConfig.mockReturnValue(undefined);
    resolveDevCloudEnvAuthority.mockReset();
    resolveDevCloudEnvAuthority.mockReturnValue(null);
    resolveDevCloudAuthorityEnvValue.mockReset();
    resolveDevCloudAuthorityEnvValue.mockImplementation(
      (key: string) => process.env[key],
    );
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

  it("returns 500 when the config commit fails", async () => {
    saveElizaConfig.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody()).toEqual({
      error: "Failed to persist first-run state",
    });
  });

  it("returns 500 when a pre-commit helper fails", async () => {
    extractAndPersistFirstRunApiKey.mockRejectedValueOnce(
      new Error("sealed secret unavailable"),
    );

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody()).toEqual({
      error: "Failed to complete first-run setup",
    });
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["staging-default", "durable"],
    ["staging-default", "sealed"],
    ["offline", "durable"],
    ["offline", "sealed"],
  ] as const)(
    "%s authority never selects or resaves a %s production Cloud key",
    async (authority, source) => {
      vi.useFakeTimers();
      try {
        const durableConfig: Record<string, unknown> = {
          cloud: {
            enabled: true,
            baseUrl: "https://api.eliza.app/api/v1",
            ...(source === "durable"
              ? { apiKey: "persisted-production-key" }
              : {}),
          },
        };
        loadElizaConfig.mockReturnValue(durableConfig);
        loadEffectiveElizaConfig.mockReturnValue({
          cloud: {
            enabled: false,
            baseUrl: "https://api-staging.eliza.app/api/v1",
            apiKey: "",
          },
        });
        getCloudSecret.mockReturnValue("sealed-production-key");
        normalizeLinkedAccountFlagsConfig.mockReturnValue({
          elizacloud: { status: "linked" },
        });
        resolveDevCloudEnvAuthority.mockReturnValue(authority);
        resolveDevCloudAuthorityEnvValue.mockReturnValue("");

        const { handled, res } = await postFirstRun(
          JSON.stringify({
            linkedAccounts: { elizacloud: { status: "linked" } },
            credentialInputs: {
              cloudApiKey: "request-production-key",
              llmApiKey: "direct-provider-key",
            },
          }),
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(getCloudSecret).not.toHaveBeenCalled();
        expect(resolveDevCloudAuthorityEnvValue).toHaveBeenCalledWith(
          "ELIZAOS_CLOUD_API_KEY",
        );
        expect(extractAndPersistFirstRunApiKey).toHaveBeenCalledWith({
          linkedAccounts: { elizacloud: { status: "linked" } },
          credentialInputs: { llmApiKey: "direct-provider-key" },
        });
        expect(saveElizaConfig).toHaveBeenCalledTimes(1);
        const persisted = saveElizaConfig.mock.calls[0]?.[0] as {
          cloud?: { apiKey?: string };
        };
        expect(persisted.cloud?.apiKey).toBe(
          source === "durable" ? "persisted-production-key" : undefined,
        );
        expect(loadEffectiveElizaConfig).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("syncs only non-Cloud first-run state under launcher authority", async () => {
    const durableCloud = {
      enabled: true,
      apiKey: "persisted-production-key",
      serviceKey: "persisted-production-service-key",
      baseUrl: "https://api.eliza.app/api/v1",
    };
    const durableAgents = {
      list: [
        {
          id: "main",
          settings: { ELIZAOS_CLOUD_API_KEY: "persisted-production-key" },
        },
      ],
    };
    loadElizaConfig.mockReturnValue({
      agents: durableAgents,
      cloud: durableCloud,
    });
    loadEffectiveElizaConfig.mockReturnValue({
      meta: { firstRunComplete: true },
      agents: { list: [{ id: "main" }] },
      ui: { assistant: { name: "Eliza" } },
      cloud: {
        enabled: false,
        apiKey: "",
        baseUrl: "https://api-staging.eliza.app/api/v1",
      },
      deploymentTarget: { runtime: "local" },
      linkedAccounts: {},
      serviceRouting: { llmText: { transport: "direct", backend: "openai" } },
    });
    resolveDevCloudEnvAuthority.mockReturnValue("staging-default");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { handleFirstRunRoute } = await import("./first-run-routes");
      const res = responseSink();
      const handled = await handleFirstRunRoute(
        requestWithRawBody('{"name":"Eliza"}', "/api/first-run", 2138),
        res,
        emptyState(),
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const patch = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(patch).toEqual({
        meta: { firstRunComplete: true },
        agents: durableAgents,
        ui: { assistant: { name: "Eliza" } },
      });
      expect(patch).not.toHaveProperty("cloud");
      expect(patch).not.toHaveProperty("deploymentTarget");
      expect(patch).not.toHaveProperty("linkedAccounts");
      expect(patch).not.toHaveProperty("serviceRouting");
      const persisted = saveElizaConfig.mock.calls[0]?.[0] as {
        cloud?: Record<string, unknown>;
      };
      expect(persisted.cloud).toEqual(durableCloud);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
