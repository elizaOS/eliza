// External-API parser contract test for the Vincent OAuth flow.
//
// Drives the REAL route handler (handleVincentRoute in ./routes.ts) end to end
// over real-shaped heyvincent.ai OAuth payloads with a global fetch stub. This
// exercises parseJsonRecord / readStringField — the parsing seam that turns the
// external provider's JSON into persisted tokens — which the live-gated
// vincent-api.real.e2e.test.ts never covers (it only hits local /status and
// /disconnect with no Vincent backend).
//
// Payload shapes verified against the OAuth specs Vincent implements:
//   - POST /api/oauth/public/register  -> RFC 7591 Dynamic Client Registration:
//     a JSON object whose `client_id` is the registered client identifier.
//   - POST /api/oauth/public/token     -> RFC 6749 §5.1 Access Token Response:
//     { access_token, token_type, expires_in, refresh_token }.
// These are the exact fields routes.ts reads (client_id / access_token /
// refresh_token); the stub returns the spec-shaped envelope so the assertions
// validate the real contract, not a hand-tailored fixture.

import { EventEmitter } from "node:events";
import type http from "node:http";
import type { ElizaConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveElizaConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/agent/config/config", () => ({
  saveElizaConfig: saveElizaConfigMock,
}));

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleVincentRoute } from "./routes";

const HOST = "127.0.0.1:31337";

/** Minimal http.IncomingMessage: host header, url, and the data/end stream
 *  events that routes.ts `readBody` consumes. */
function makeReq(url: string, body?: string): http.IncomingMessage {
  const emitter = new EventEmitter() as unknown as http.IncomingMessage;
  emitter.headers = { host: HOST };
  emitter.url = url;
  // readBody attaches its data/end listeners synchronously inside the handler;
  // emit on the next tick so they are registered first.
  process.nextTick(() => {
    if (body !== undefined) emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });
  return emitter;
}

interface CaptureRes {
  res: http.ServerResponse;
  result(): { status: number; contentType: string; body: string };
}

function makeRes(): CaptureRes {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      status = this.statusCode;
      body = chunk ?? "";
      this.headersSent = true;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    result: () => ({
      status,
      contentType: headers["content-type"] ?? "",
      body,
    }),
  };
}

function freshState(): { config: ElizaConfig } {
  return { config: {} as ElizaConfig };
}

/** Stub global fetch with per-endpoint responses. */
function stubFetch(
  responders: Record<string, { ok: boolean; status: number; json: unknown }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      const match = Object.keys(responders).find((path) => url.includes(path));
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      const r = responders[match];
      const text = JSON.stringify(r.json);
      return {
        ok: r.ok,
        status: r.status,
        text: async () => text,
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  saveElizaConfigMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startLogin(state: {
  config: ElizaConfig;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = makeReq("/api/vincent/start-login", JSON.stringify({}));
  const cap = makeRes();
  const handled = await handleVincentRoute(
    req,
    cap.res,
    "/api/vincent/start-login",
    "POST",
    state,
  );
  expect(handled).toBe(true);
  const { status, body } = cap.result();
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

describe("Vincent OAuth parser — happy path", () => {
  it("builds a spec-valid authUrl and persists tokens parsed from real-shaped responses", async () => {
    const state = freshState();

    // 1) register -> RFC 7591 { client_id, ... }.
    stubFetch({
      "/api/oauth/public/register": {
        ok: true,
        status: 200,
        json: {
          client_id: "vincent-client-abc123",
          client_name: "Eliza",
          redirect_uris: [`http://${HOST}/callback/vincent`],
          token_endpoint_auth_method: "none",
        },
      },
    });

    const login = await startLogin(state);
    expect(login.status).toBe(200);

    // authUrl carries every PKCE/OAuth param routes.ts must emit.
    const authUrl = new URL(String(login.body.authUrl));
    expect(authUrl.origin + authUrl.pathname).toBe(
      "https://heyvincent.ai/api/oauth/public/authorize",
    );
    expect(authUrl.searchParams.get("client_id")).toBe("vincent-client-abc123");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `http://${HOST}/callback/vincent`,
    );
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    const stateParam = authUrl.searchParams.get("state");
    expect(stateParam).toBe(login.body.state);
    expect(stateParam).toBeTruthy();

    // 2) callback exchanges the code -> RFC 6749 token response.
    stubFetch({
      "/api/oauth/public/token": {
        ok: true,
        status: 200,
        json: {
          access_token: "vincent-access-token-xyz",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "vincent-refresh-token-789",
          scope: "all",
        },
      },
    });

    const cbReq = makeReq(
      `/callback/vincent?code=auth-code-123&state=${stateParam}`,
    );
    const cbCap = makeRes();
    const cbHandled = await handleVincentRoute(
      cbReq,
      cbCap.res,
      "/callback/vincent",
      "GET",
      state,
    );
    expect(cbHandled).toBe(true);

    const cb = cbCap.result();
    expect(cb.status).toBe(200);
    expect(cb.contentType).toContain("text/html");
    expect(cb.body).toContain("Vincent connected");

    // Tokens parsed from the real-shaped payload are persisted to config.vincent.
    expect(saveElizaConfigMock).toHaveBeenCalledTimes(1);
    const persisted = Reflect.get(state.config, "vincent") as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({
      accessToken: "vincent-access-token-xyz",
      refreshToken: "vincent-refresh-token-789",
      clientId: "vincent-client-abc123",
    });
    expect(typeof persisted.connectedAt).toBe("number");
  });
});

describe("Vincent OAuth parser — malformed responses are rejected", () => {
  it("register payload without client_id -> 502, no pending login created", async () => {
    const state = freshState();
    stubFetch({
      "/api/oauth/public/register": {
        ok: true,
        status: 200,
        // Missing client_id (e.g. an error envelope) — readStringField returns
        // null and the handler must refuse rather than build a broken authUrl.
        json: { error: "invalid_client_metadata" },
      },
    });

    const login = await startLogin(state);
    expect(login.status).toBe(502);
    expect(login.body.authUrl).toBeUndefined();
  });

  it("token response missing access_token -> 502 callback HTML, tokens not saved", async () => {
    const state = freshState();

    // Seed a valid pending login first.
    stubFetch({
      "/api/oauth/public/register": {
        ok: true,
        status: 200,
        json: { client_id: "vincent-client-def456" },
      },
    });
    const login = await startLogin(state);
    const stateParam = new URL(String(login.body.authUrl)).searchParams.get(
      "state",
    );

    // Token exchange returns a payload with no access_token.
    stubFetch({
      "/api/oauth/public/token": {
        ok: true,
        status: 200,
        json: { token_type: "Bearer", expires_in: 3600 },
      },
    });

    const cbReq = makeReq(
      `/callback/vincent?code=auth-code-456&state=${stateParam}`,
    );
    const cbCap = makeRes();
    await handleVincentRoute(
      cbReq,
      cbCap.res,
      "/callback/vincent",
      "GET",
      state,
    );

    const cb = cbCap.result();
    expect(cb.status).toBe(502);
    expect(cb.body).toContain("Vincent login failed");
    expect(saveElizaConfigMock).not.toHaveBeenCalled();
    expect(Reflect.get(state.config, "vincent")).toBeUndefined();
  });
});
