/**
 * Route behavior of app-core `POST /api/first-run` beyond the JSON-body
 * contract already covered by `first-run-routes.json-body.test.ts`:
 * dispatch gating (method/path), route authorization, deprecated payload
 * rejection, stream read failures, agent-name capture, the three-way cloud
 * API key resolution order, loopback `/api/config` syncing, deferred runtime
 * boot gating, and the defensive delayed `cloud.apiKey` resave.
 *
 * Deterministic harness: the real `handleFirstRunRoute` runs against
 * in-memory request/response doubles and stubbed collaborators; every case
 * asserts observed HTTP output or persisted state, never mock internals.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const logDebug = vi.fn();
const logError = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();

const ensureRouteAuthorized = vi.fn<() => Promise<boolean>>();
const loadElizaConfig = vi.fn<() => Record<string, unknown>>();
const saveElizaConfig = vi.fn<(config: unknown) => void>();
const applyCanonicalFirstRunConfig = vi.fn<(config: unknown) => void>();

type ReadBodyOptions = {
  maxBytes?: number;
  returnNullOnTooLarge?: boolean;
};
const readRequestBody =
  vi.fn<
    (
      req: http.IncomingMessage,
      options: ReadBodyOptions,
    ) => Promise<string | null>
  >();

async function readStreamBody(
  req: http.IncomingMessage,
  options: ReadBodyOptions,
): Promise<string | null> {
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
}

const getCloudSecret = vi.fn<(name: string) => string | undefined>();
const migrateLegacyRuntimeConfig = vi.fn<(config: unknown) => void>();
const normalizeDeploymentTargetConfig = vi.fn<(value: unknown) => unknown>();
const normalizeFirstRunProviderId = vi.fn<(value: unknown) => string | null>();
const normalizeLinkedAccountFlagsConfig = vi.fn<(value: unknown) => unknown>();
const normalizeServiceRoutingConfig = vi.fn<(value: unknown) => unknown>();

const hasDeprecatedFirstRunRequestFields =
  vi.fn<(body: Record<string, unknown>) => boolean>();
const extractAndPersistFirstRunApiKey =
  vi.fn<(body: Record<string, unknown>) => Promise<void>>();
const persistFirstRunDefaults =
  vi.fn<(body: Record<string, unknown>) => void>();

const hasCompatPersistedFirstRunState = vi.fn<(config: unknown) => boolean>();
const isRuntimeBootDeferred = vi.fn<() => boolean>();
const triggerDeferredRuntimeBoot = vi.fn<(reason: string) => Promise<void>>();

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: logDebug,
    error: logError,
    info: logInfo,
    warn: logWarn,
  },
  readRequestBody,
}));

vi.mock("@elizaos/agent", () => ({
  applyCanonicalFirstRunConfig,
  loadElizaConfig,
  saveElizaConfig,
}));

vi.mock("@elizaos/shared", () => ({
  getCloudSecret,
  migrateLegacyRuntimeConfig,
  normalizeDeploymentTargetConfig,
  normalizeFirstRunProviderId,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized,
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized,
}));

vi.mock("./compat-route-shared", () => ({
  hasCompatPersistedFirstRunState,
}));

vi.mock("./deferred-runtime-boot", () => ({
  isRuntimeBootDeferred,
  triggerDeferredRuntimeBoot,
}));

vi.mock("./server-first-run-helpers", () => ({
  deriveFirstRunReplayBody: (body: Record<string, unknown>) => ({
    replayBody: body,
  }),
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields,
  persistFirstRunDefaults,
}));

type RequestOverrides = {
  pathname?: string;
  method?: string;
  authorization?: string;
  localPort?: number;
};

function requestWithRawBody(
  raw: string,
  overrides: RequestOverrides = {},
): http.IncomingMessage {
  const stream = Readable.from(
    raw.length === 0 ? [] : [Buffer.from(raw, "utf8")],
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (overrides.authorization) {
    headers.authorization = overrides.authorization;
  }
  return Object.assign(stream, {
    headers,
    method: overrides.method ?? "POST",
    socket: { localPort: overrides.localPort },
    url: overrides.pathname ?? "/api/first-run",
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

async function postFirstRun(raw: string, overrides: RequestOverrides = {}) {
  const { handleFirstRunRoute } = await import("./first-run-routes");
  const state = emptyState();
  const res = responseSink();
  const handled = await handleFirstRunRoute(
    requestWithRawBody(raw, overrides),
    res,
    state,
  );
  return { handled, res, state };
}

function savedPayload(call: number): Record<string, unknown> {
  return saveElizaConfig.mock.calls[call]?.[0] as Record<string, unknown>;
}

describe("POST /api/first-run route behavior", () => {
  let priorCloudEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    priorCloudEnv = process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_API_KEY;

    ensureRouteAuthorized.mockReset().mockResolvedValue(true);
    loadElizaConfig.mockReset().mockImplementation(() => ({}));
    saveElizaConfig.mockReset().mockReturnValue(undefined);
    applyCanonicalFirstRunConfig.mockReset().mockReturnValue(undefined);
    readRequestBody.mockReset().mockImplementation(readStreamBody);
    getCloudSecret.mockReset().mockReturnValue(undefined);
    migrateLegacyRuntimeConfig.mockReset().mockReturnValue(undefined);
    normalizeDeploymentTargetConfig.mockReset().mockReturnValue(undefined);
    normalizeFirstRunProviderId.mockReset().mockReturnValue(null);
    normalizeLinkedAccountFlagsConfig.mockReset().mockReturnValue(undefined);
    normalizeServiceRoutingConfig.mockReset().mockReturnValue(undefined);
    hasDeprecatedFirstRunRequestFields.mockReset().mockReturnValue(false);
    extractAndPersistFirstRunApiKey.mockReset().mockResolvedValue(undefined);
    persistFirstRunDefaults.mockReset().mockReturnValue(undefined);
    hasCompatPersistedFirstRunState.mockReset().mockReturnValue(false);
    isRuntimeBootDeferred.mockReset().mockReturnValue(false);
    triggerDeferredRuntimeBoot.mockReset().mockReturnValue(Promise.resolve());
    logDebug.mockReset();
    logError.mockReset();
    logInfo.mockReset();
    logWarn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (priorCloudEnv === undefined) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    } else {
      process.env.ELIZAOS_CLOUD_API_KEY = priorCloudEnv;
    }
  });

  it("does not handle a GET to the first-run path", async () => {
    const { handled } = await postFirstRun("{}", { method: "GET" });

    expect(handled).toBe(false);
    expect(ensureRouteAuthorized).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("short-circuits without responding or persisting when unauthorized", async () => {
    ensureRouteAuthorized.mockResolvedValue(false);

    const { handled, res } = await postFirstRun('{"name":"Eliza"}');

    expect(handled).toBe(true);
    expect(res.headersSent).toBe(false);
    expect(extractAndPersistFirstRunApiKey).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects a deprecated payload shape with the migration hint", async () => {
    hasDeprecatedFirstRunRequestFields.mockReturnValue(true);

    const { handled, res } = await postFirstRun('{"model":"gpt-4o"}');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody()).toEqual({
      error:
        "deprecated first-run payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs",
    });
    expect(persistFirstRunDefaults).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("maps a broken request stream to a 400 read failure", async () => {
    readRequestBody.mockRejectedValueOnce(new Error("stream aborted"));

    const { handled, res } = await postFirstRun("{}");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody()).toEqual({
      error: "failed to read onboarding request body: stream aborted",
    });
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("persists firstRunComplete and captures the trimmed agent name", async () => {
    const { handled, res, state } = await postFirstRun(
      '{"name":"  Ada Lovelace  "}',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toEqual({ ok: true });
    expect(state.pendingAgentName).toBe("Ada Lovelace");
    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
    expect(savedPayload(0)?.meta).toMatchObject({ firstRunComplete: true });
    expect(triggerDeferredRuntimeBoot).not.toHaveBeenCalled();
  });

  it("leaves pendingAgentName alone for a whitespace-only name", async () => {
    const { res, state } = await postFirstRun('{"name":"   "}');

    expect(res.statusCode).toBe(200);
    expect(state.pendingAgentName).toBeNull();
  });

  it("leaves pendingAgentName alone for a non-string name", async () => {
    const { res, state } = await postFirstRun('{"name":42}');

    expect(res.statusCode).toBe(200);
    expect(state.pendingAgentName).toBeNull();
  });

  it("keeps an existing config cloud.apiKey over other sources", async () => {
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "cloud" });
    loadElizaConfig.mockImplementation(() => ({
      cloud: { apiKey: "cfg-key" },
    }));
    getCloudSecret.mockReturnValue("sealed-key");

    const { handled, res } = await postFirstRun("{}");

    expect(handled).toBe(true);
    expect(res.jsonBody()).toEqual({ ok: true });
    expect(getCloudSecret).not.toHaveBeenCalled();
    expect(savedPayload(0)?.cloud).toMatchObject({ apiKey: "cfg-key" });
    expect(savedPayload(0)?.meta).toMatchObject({ firstRunComplete: true });
  });

  it("falls back to the sealed secret and writes it into the saved config", async () => {
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "cloud" });
    loadElizaConfig.mockImplementation(() => ({}));
    getCloudSecret.mockReturnValue("sealed-key");

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(getCloudSecret).toHaveBeenCalledWith("ELIZAOS_CLOUD_API_KEY");
    expect(savedPayload(0)?.cloud).toMatchObject({ apiKey: "sealed-key" });
  });

  it("resolves the key from env for cloud-proxy elizacloud routing", async () => {
    normalizeServiceRoutingConfig.mockReturnValue({
      llmText: { transport: "cloud-proxy", backend: "elizacloud-prod" },
    });
    normalizeFirstRunProviderId.mockReturnValue("elizacloud");
    loadElizaConfig.mockImplementation(() => ({}));
    process.env.ELIZAOS_CLOUD_API_KEY = "env-key";

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(getCloudSecret).toHaveBeenCalledTimes(1);
    expect(savedPayload(0)?.cloud).toMatchObject({ apiKey: "env-key" });
  });

  it("still commits a linked cloud run when no key source exists", async () => {
    normalizeLinkedAccountFlagsConfig.mockReturnValue({
      elizacloud: { status: "linked" },
    });
    loadElizaConfig.mockImplementation(() => ({}));

    const { res } = await postFirstRun("{}");

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toEqual({ ok: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("no API key found"),
    );
    expect(savedPayload(0)?.cloud).toEqual({});
  });

  it("mirrors only merged allowlisted keys through the loopback config sync", async () => {
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "cloud" });
    loadElizaConfig.mockImplementation(() => ({
      junk: "stay-local",
      cloud: { apiKey: "cfg-key" },
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { res } = await postFirstRun("{}", {
      localPort: 45123,
      authorization: "Bearer session-token",
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:45123/api/config");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer session-token");
    expect(headers["content-type"]).toBe("application/json");
    const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["cloud", "meta"]);
    expect(patch.junk).toBeUndefined();
    expect(patch.meta).toMatchObject({ firstRunComplete: true });
  });

  it("returns 500 when the loopback config sync fails after the disk save", async () => {
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "cloud" });
    loadElizaConfig.mockImplementation(() => ({}));
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "boom",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { res } = await postFirstRun("{}", { localPort: 45123 });

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody()).toEqual({
      error: "Failed to persist first-run state",
    });
    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
  });

  it("boots the deferred runtime for a committed local target", async () => {
    isRuntimeBootDeferred.mockReturnValue(true);
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "local" });
    hasCompatPersistedFirstRunState.mockReturnValue(true);

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(triggerDeferredRuntimeBoot).toHaveBeenCalledTimes(1);
    expect(triggerDeferredRuntimeBoot).toHaveBeenCalledWith(
      "first-run onboarding committed",
    );
  });

  it("contains a deferred boot rejection without failing the response", async () => {
    isRuntimeBootDeferred.mockReturnValue(true);
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "local" });
    hasCompatPersistedFirstRunState.mockReturnValue(true);
    triggerDeferredRuntimeBoot.mockReturnValue(
      Promise.reject(new Error("boot blew up")),
    );

    const { res } = await postFirstRun("{}");

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody()).toEqual({ ok: true });
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("boot blew up"),
    );
  });

  it("skips the deferred boot for a cloud target", async () => {
    isRuntimeBootDeferred.mockReturnValue(true);
    hasCompatPersistedFirstRunState.mockReturnValue(true);
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "cloud" });

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(triggerDeferredRuntimeBoot).not.toHaveBeenCalled();
  });

  it("skips the deferred boot when no first-run state is persisted", async () => {
    isRuntimeBootDeferred.mockReturnValue(true);
    normalizeDeploymentTargetConfig.mockReturnValue({ runtime: "local" });

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(hasCompatPersistedFirstRunState).toHaveBeenCalledTimes(1);
    expect(triggerDeferredRuntimeBoot).not.toHaveBeenCalled();
  });

  it("re-saves a clobbered cloud.apiKey after the defensive delay", async () => {
    normalizeLinkedAccountFlagsConfig.mockReturnValue({
      elizacloud: { status: "linked" },
    });
    getCloudSecret.mockReturnValue("sealed-key");
    let loadCount = 0;
    loadElizaConfig.mockReset().mockImplementation(() => {
      loadCount += 1;
      if (loadCount === 1) return {};
      return { agents: [] };
    });

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });
    expect(saveElizaConfig).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);

    expect(saveElizaConfig).toHaveBeenCalledTimes(2);
    expect(savedPayload(1)?.cloud).toMatchObject({ apiKey: "sealed-key" });
    expect(migrateLegacyRuntimeConfig).toHaveBeenCalled();
  });

  it("leaves the resave as a no-op when cloud.apiKey survived", async () => {
    normalizeLinkedAccountFlagsConfig.mockReturnValue({
      elizacloud: { status: "linked" },
    });
    getCloudSecret.mockReturnValue("sealed-key");
    loadElizaConfig.mockImplementation(() => ({
      cloud: { apiKey: "sealed-key" },
    }));

    const { res } = await postFirstRun("{}");

    expect(res.jsonBody()).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(3000);

    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
    expect(migrateLegacyRuntimeConfig).not.toHaveBeenCalled();
  });
});
