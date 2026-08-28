/**
 * `POST /api/cloud/login/persist` untrusted JSON body contract.
 *
 * The route reads the client body through `readRouteJsonBody` and then maps
 * handler failures to 500. Syntax errors and non-object JSON are client
 * garbage and must be 400 `{ ok: false }`, not a server fault. Empty bodies
 * still become `{}` and keep the existing missing-`apiKey` 400. Persistence
 * failures after a valid object remain 500. Deterministic handler tests
 * against the real `handleCloudRoute` (no mocked parser).
 */

import type http from "node:http";
import { Readable } from "node:stream";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CloudRouteState, handleCloudRoute } from "../src/routes/cloud-routes";

const priorApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
const priorEnabled = process.env.ELIZAOS_CLOUD_ENABLED;
const priorDevSource = process.env.ELIZA_DEV_SOURCE;
const priorDevCloudAuthority = process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;

afterEach(() => {
  if (priorApiKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
  else process.env.ELIZAOS_CLOUD_API_KEY = priorApiKey;
  if (priorEnabled === undefined) delete process.env.ELIZAOS_CLOUD_ENABLED;
  else process.env.ELIZAOS_CLOUD_ENABLED = priorEnabled;
  if (priorDevSource === undefined) delete process.env.ELIZA_DEV_SOURCE;
  else process.env.ELIZA_DEV_SOURCE = priorDevSource;
  if (priorDevCloudAuthority === undefined) {
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  } else {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = priorDevCloudAuthority;
  }
  resetDevCloudEnvAuthorityForTests();
  vi.restoreAllMocks();
});

function requestWithRawBody(raw: string): http.IncomingMessage {
  const stream = Readable.from(raw.length === 0 ? [] : [Buffer.from(raw, "utf8")]);
  return Object.assign(stream, {
    headers: { "content-type": "application/json" },
    method: "POST",
    url: "/api/cloud/login/persist",
  }) as unknown as http.IncomingMessage;
}

function requestWithParsedBody(body: unknown): http.IncomingMessage {
  return {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
    url: "/api/cloud/login/persist",
  } as http.IncomingMessage & { body: unknown };
}

function responseSink(): http.ServerResponse & {
  jsonBody: () => unknown;
} {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return {} as http.ServerResponse;
    },
    jsonBody: () => (body ? JSON.parse(body) : undefined),
  };
  return sink as http.ServerResponse & { jsonBody: () => unknown };
}

function persistState(overrides: Partial<CloudRouteState> = {}): CloudRouteState {
  return {
    config: {},
    cloudManager: null,
    runtime: null,
    ...overrides,
  };
}

async function persistRaw(raw: string, state?: CloudRouteState) {
  const res = responseSink();
  const handled = await handleCloudRoute(
    requestWithRawBody(raw),
    res,
    "/api/cloud/login/persist",
    "POST",
    state ?? persistState()
  );
  return { handled, statusCode: res.statusCode, body: res.jsonBody() };
}

describe("POST /api/cloud/login/persist JSON body", () => {
  it("returns 400 ok:false for syntactically invalid JSON", async () => {
    const result = await persistRaw("{not-json");
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("returns 400 ok:false for a JSON array", async () => {
    const result = await persistRaw('["apiKey"]');
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("returns 400 ok:false for a JSON primitive", async () => {
    const result = await persistRaw('"eliza_not_an_object"');
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("returns 400 ok:false for JSON null", async () => {
    const result = await persistRaw("null");
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("keeps the empty-body missing-apiKey 400", async () => {
    const result = await persistRaw("");
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "apiKey is required" });
  });

  it("returns 400 for a JSON object missing apiKey", async () => {
    const result = await persistRaw("{}");
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "apiKey is required" });
  });

  it("returns 400 for a blank apiKey on a pre-parsed object", async () => {
    const res = responseSink();
    const handled = await handleCloudRoute(
      requestWithParsedBody({ apiKey: "   " }),
      res,
      "/api/cloud/login/persist",
      "POST",
      persistState()
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody()).toEqual({ ok: false, error: "apiKey is required" });
  });

  it.each([
    ["array", []],
    ["primitive", "apiKey"],
    ["null", null],
  ] as const)("returns 400 for a pre-parsed %s body", async (_label, body) => {
    const res = responseSink();
    const handled = await handleCloudRoute(
      requestWithParsedBody(body),
      res,
      "/api/cloud/login/persist",
      "POST",
      persistState()
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody()).toEqual({
      ok: false,
      error: "Invalid JSON body",
    });
  });

  it("keeps persistence failures as 500 after a valid object body", async () => {
    const result = await persistRaw(
      JSON.stringify({ apiKey: "eliza_valid_looking_key" }),
      persistState({
        cloudManager: {
          replaceApiKey: async () => {
            throw new Error("Cloud credential persistence was not applied");
          },
        } as CloudRouteState["cloudManager"],
      })
    );
    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(500);
    expect(result.body).toEqual({
      ok: false,
      error: "Cloud credential persistence was not applied",
    });
  });

  it("rejects even the launcher key before direct persistence side effects", async () => {
    resetDevCloudEnvAuthorityForTests();
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "launcher-staging-key";
    const saveElizaConfig = vi.fn();
    const replaceApiKey = vi.fn(async () => {});
    const config = { cloud: { apiKey: "durable-production-key" } };

    const result = await persistRaw(
      JSON.stringify({ apiKey: "launcher-staging-key" }),
      persistState({
        config,
        cloudManager: { replaceApiKey } as CloudRouteState["cloudManager"],
        services: { saveElizaConfig },
      })
    );

    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({
      ok: false,
      error:
        "Cloud login cannot persist credentials owned by the immutable local development launch target",
    });
    expect(config).toEqual({ cloud: { apiKey: "durable-production-key" } });
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(replaceApiKey).not.toHaveBeenCalled();
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("launcher-staging-key");
  });

  it("rejects an authenticated same-key poll before fetch or persistence side effects", async () => {
    resetDevCloudEnvAuthorityForTests();
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "launcher-staging-key";
    const saveElizaConfig = vi.fn();
    const replaceApiKey = vi.fn(async () => {});
    const config = { cloud: { apiKey: "durable-production-key" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "authenticated",
          apiKey: "launcher-staging-key",
          keyPrefix: "launcher",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const req = {
      headers: { host: "127.0.0.1:3000" },
      method: "GET",
      url: "/api/cloud/login/status?sessionId=same-key-session",
    } as http.IncomingMessage;
    const res = responseSink();

    const handled = await handleCloudRoute(
      req,
      res,
      "/api/cloud/login/status",
      "GET",
      persistState({
        config,
        cloudManager: { replaceApiKey } as CloudRouteState["cloudManager"],
        services: {
          saveElizaConfig,
          validateCloudBaseUrl: async () => null,
        },
      })
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.jsonBody()).toEqual({
      ok: false,
      error:
        "Cloud login cannot persist credentials owned by the immutable local development launch target",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(config).toEqual({ cloud: { apiKey: "durable-production-key" } });
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(replaceApiKey).not.toHaveBeenCalled();
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("launcher-staging-key");
  });
});
