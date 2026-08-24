/**
 * Focused contracts for configured API-token validation and exact credential
 * attempt detection across every supported header, cookie, and gated SSE
 * query channel. Aggregate loopback trust must never masquerade as a token.
 */

import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasPresentedAuthCredential,
  hasPresentedHostCredential,
  isAuthorized,
  isConfiguredApiTokenAuthorized,
} from "./server-helpers-auth.ts";

const ENV_KEYS = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZA_REQUIRE_LOCAL_AUTH",
] as const;
const savedEnv = new Map<string, string | undefined>();

function request(
  headers: http.IncomingHttpHeaders,
  remoteAddress = "203.0.113.15",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { host: "agent.example.test", ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ELIZA_API_TOKEN = "configured-diagnostics-token";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("isConfiguredApiTokenAuthorized", () => {
  it("accepts only the exact configured bearer token", () => {
    expect(
      isConfiguredApiTokenAuthorized(
        request({ authorization: "Bearer configured-diagnostics-token" }),
      ),
    ).toBe(true);
    expect(
      isConfiguredApiTokenAuthorized(
        request({ authorization: "Bearer configured-diagnostics-tokem" }),
      ),
    ).toBe(false);
    expect(isConfiguredApiTokenAuthorized(request({}))).toBe(false);
  });

  it("does not promote aggregate trusted-loopback authority", () => {
    const local = request({ host: "127.0.0.1:2138" }, "127.0.0.1");
    expect(isAuthorized(local)).toBe(true);
    expect(isConfiguredApiTokenAuthorized(local)).toBe(false);
  });

  it("does not promote a valid service-gateway token", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = "service-gateway-secret";
    const service = request({
      "x-server-token": "service-gateway-secret",
    });
    expect(isAuthorized(service)).toBe(true);
    expect(isConfiguredApiTokenAuthorized(service)).toBe(false);
  });
});

describe("presented credential detection", () => {
  it("distinguishes absent credentials from host credential attempts", () => {
    expect(hasPresentedAuthCredential(request({}))).toBe(false);
    expect(hasPresentedHostCredential(request({}))).toBe(false);
    expect(hasPresentedHostCredential(request({ authorization: "" }))).toBe(
      true,
    );
    expect(hasPresentedHostCredential(request({ "x-api-token": "" }))).toBe(
      true,
    );
    expect(
      hasPresentedAuthCredential(request({ "x-api-token": "wrong" })),
    ).toBe(true);
    expect(
      isConfiguredApiTokenAuthorized(
        request({ "x-api-token": "configured-diagnostics-token" }),
      ),
    ).toBe(false);
    expect(
      hasPresentedAuthCredential(request({ authorization: "Basic wrong" })),
    ).toBe(true);
    expect(
      hasPresentedHostCredential(request({ cookie: "eliza_session=" })),
    ).toBe(true);
    expect(
      hasPresentedAuthCredential(request({ cookie: "unrelated=value" })),
    ).toBe(false);
  });

  it.each([
    "x-server-token",
    "x-eliza-token",
    "x-elizaos-token",
    "x-waifu-chat-access-token",
    "x-api-key",
  ])("detects empty and wrong %s attempts", (header) => {
    expect(hasPresentedAuthCredential(request({ [header]: "" }))).toBe(true);
    expect(hasPresentedAuthCredential(request({ [header]: "wrong" }))).toBe(
      true,
    );
  });

  it("detects only supported and gated SSE query attempts", () => {
    const queryRequest = request({ accept: "text/event-stream" });
    queryRequest.method = "GET";
    queryRequest.url = "/api/logs?api_key=wrong";
    expect(hasPresentedAuthCredential(queryRequest)).toBe(false);

    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    expect(hasPresentedAuthCredential(queryRequest)).toBe(true);

    const emptyQueryRequest = request({ accept: "text/event-stream" });
    emptyQueryRequest.method = "GET";
    emptyQueryRequest.url = "/api/logs?token=";
    expect(hasPresentedAuthCredential(emptyQueryRequest)).toBe(true);

    const unsupportedRequest = request({ accept: "application/json" });
    unsupportedRequest.method = "GET";
    unsupportedRequest.url = "/api/logs?token=wrong";
    expect(hasPresentedAuthCredential(unsupportedRequest)).toBe(false);
  });
});
