/**
 * HTTP authentication is translated into disclosure principals without
 * trusting request-body identity or channel fields. These tests use real
 * IncomingMessage headers and the production token classifier.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrustedApiPrincipal } from "./chat-routes.ts";

const SERVER_SECRET = "server-token-fixture-".padEnd(64, "s");
const OWNER_API_TOKEN = "owner-api-token-fixture-".padEnd(64, "o");
const ENV_KEYS = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_API_TOKEN",
  "ELIZA_REQUIRE_LOCAL_AUTH",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function makeRemoteRequest(
  headers: http.IncomingHttpHeaders,
  body?: unknown,
): http.IncomingMessage {
  const request = new http.IncomingMessage(new Socket());
  request.headers = { host: "agent.example.test", ...headers };
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "203.0.113.19",
    configurable: true,
  });
  Object.assign(request, { body });
  return request;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe("resolveTrustedApiPrincipal", () => {
  it("keeps a server-token request external despite owner-looking host and body fields", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SERVER_SECRET;
    const request = makeRemoteRequest(
      { "x-server-token": SERVER_SECRET },
      {
        role: "OWNER",
        channelType: "DM",
        source: "owner_app",
        principalId: "body-claimed-owner",
      },
    );

    expect(
      resolveTrustedApiPrincipal(request, {
        ok: true,
        role: "OWNER",
        identityId: "host-owner-identity",
        principal: "gateway-principal",
      }),
    ).toEqual({
      kind: "service_gateway",
      principalId: "gateway-principal",
    });
  });

  it("does not elevate an authenticated external host caller from body claims", () => {
    const request = makeRemoteRequest(
      {},
      {
        role: "OWNER",
        owner: true,
        channelType: "DM",
      },
    );

    expect(
      resolveTrustedApiPrincipal(request, {
        ok: true,
        role: "GUEST",
        identityId: "external-session",
      }),
    ).toEqual({
      kind: "service_gateway",
      principalId: "external-session",
    });
  });

  it("recognizes an owner role resolved by the host session boundary", () => {
    expect(
      resolveTrustedApiPrincipal(makeRemoteRequest({}), {
        ok: true,
        role: "OWNER",
        identityId: "owner-session-id",
      }),
    ).toEqual({
      kind: "owner_session",
      principalId: "owner-session-id",
    });
  });

  it("recognizes the configured direct API bearer independently of body metadata", () => {
    process.env.ELIZA_API_TOKEN = OWNER_API_TOKEN;
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";

    expect(
      resolveTrustedApiPrincipal(
        makeRemoteRequest(
          { authorization: `Bearer ${OWNER_API_TOKEN}` },
          { role: "GUEST", channelType: "GROUP" },
        ),
        undefined,
      ),
    ).toEqual({
      kind: "owner_api_token",
      principalId: "direct-owner-api",
    });
  });
});
