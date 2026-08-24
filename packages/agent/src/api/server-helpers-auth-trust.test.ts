/**
 * Pins that the agent's `isTrustedLocalRequest` wrapper binds its exact policy
 * gates to the canonical `@elizaos/shared` parser: cloudCheck "container"
 * (flag AND a provisioning token), ELIZA_REQUIRE_LOCAL_AUTH honoured, and NO
 * dev-auth bypass. If the wrapper swaps cloudCheck to "env" or enables the dev
 * bypass, these assertions break. Also covers isWebSocketAuthorized /
 * resolveWebSocketUpgradeRejection loopback parity and resolveBoundaryRole
 * (OWNER for trusted loopback, GUEST fail-closed for remote tokenless callers).
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasPresentedAuthCredential,
  hasPresentedHostCredential,
  isConfiguredApiTokenAuthorized,
  isTrustedLocalRequest,
  isWebSocketAuthorized,
  resolveBoundaryRole,
  resolveWebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";

function makeReq(
  headers: http.IncomingHttpHeaders,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

const localReq = () => makeReq({ host: "localhost:2138" });

const ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "NODE_ENV",
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("agent isTrustedLocalRequest wrapper (policy gates)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("trusts a bare loopback request when no gate is set", () => {
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("ELIZA_REQUIRE_LOCAL_AUTH=1 denies trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("the agent IGNORES ELIZA_DEV_AUTH_BYPASS even in development", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("cloudCheck=container: bare ELIZA_CLOUD_PROVISIONED=1 does NOT deny trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("cloudCheck=container: flag + provisioning token denies trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("rejects a spoofed X-Forwarded-For", () => {
    expect(
      isTrustedLocalRequest(
        makeReq({ host: "localhost:2138", "x-forwarded-for": "203.0.113.9" }),
      ),
    ).toBe(false);
  });

  it("rejects a DNS-rebinding Host header (strict shared classifier)", () => {
    // The strict canonical parser rejects a rebinding host like
    // "127.0.0.1.evil.com" that a naive 127.*-prefix check would wrongly accept.
    expect(isTrustedLocalRequest(makeReq({ host: "127.0.0.1.evil.com" }))).toBe(
      false,
    );
  });
});

describe("presented credential detection", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("distinguishes absent credentials from empty or wrong accepted channels", () => {
    expect(hasPresentedAuthCredential(localReq())).toBe(false);
    expect(
      hasPresentedAuthCredential(
        makeReq({ host: "localhost:2138", authorization: "" }),
      ),
    ).toBe(true);
    expect(
      hasPresentedAuthCredential(
        makeReq({ host: "localhost:2138", "x-server-token": "wrong" }),
      ),
    ).toBe(true);
    expect(
      hasPresentedAuthCredential(
        makeReq({ host: "localhost:2138", "x-eliza-token": "wrong" }),
      ),
    ).toBe(true);
  });

  it("detects host bearer aliases and empty eliza_session cookie attempts", () => {
    expect(
      hasPresentedHostCredential(
        makeReq({ host: "localhost:2138", "x-api-token": "wrong" }),
      ),
    ).toBe(true);
    expect(
      hasPresentedHostCredential(
        makeReq({ host: "localhost:2138", cookie: "eliza_session=" }),
      ),
    ).toBe(true);
    expect(
      hasPresentedHostCredential(
        makeReq({ host: "localhost:2138", cookie: "theme=dark" }),
      ),
    ).toBe(false);
  });

  it("detects only gated SSE query-token candidates", () => {
    const req = makeReq({
      host: "localhost:2138",
      accept: "text/event-stream",
    });
    req.method = "GET";
    req.url = "/api/events?token=";
    expect(hasPresentedAuthCredential(req)).toBe(false);

    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    expect(hasPresentedAuthCredential(req)).toBe(true);
  });

  it("validates configured bearer and alias tokens without loopback trust", () => {
    process.env.ELIZA_API_TOKEN = "configured-secret";
    expect(
      isConfiguredApiTokenAuthorized(
        makeReq({
          host: "localhost:2138",
          authorization: "Bearer configured-secret",
        }),
      ),
    ).toBe(true);
    expect(
      isConfiguredApiTokenAuthorized(
        makeReq({
          host: "localhost:2138",
          "x-api-key": "configured-secret",
        }),
      ),
    ).toBe(true);
    expect(
      isConfiguredApiTokenAuthorized(
        makeReq({ host: "localhost:2138", "x-api-token": "configured-secret" }),
      ),
    ).toBe(false);
  });
});

describe("WebSocket auth no-token trust parity", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("allows loopback WebSocket upgrades without a token in local mode", () => {
    const req = localReq();
    const url = new URL("http://localhost:2138/ws");

    expect(isWebSocketAuthorized(req, url)).toBe(true);
    expect(resolveWebSocketUpgradeRejection(req, url)).toBeNull();
  });

  it("rejects remote WebSocket upgrades without a token in local mode", () => {
    const req = makeReq({ host: "203.0.113.10:2138" }, "203.0.113.10");
    const url = new URL("http://203.0.113.10:2138/ws");

    expect(isWebSocketAuthorized(req, url)).toBe(false);
    expect(resolveWebSocketUpgradeRejection(req, url)).toEqual({
      status: 401,
      reason: "Unauthorized",
    });
  });
});

describe("resolveBoundaryRole (#12087 Item 13)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("classifies a trusted loopback caller as OWNER", () => {
    expect(resolveBoundaryRole(localReq())).toBe("OWNER");
  });

  it("classifies a remote, tokenless caller as GUEST (fail closed)", () => {
    const remote = new http.IncomingMessage(new Socket());
    remote.headers = { host: "agent.example.test" };
    Object.defineProperty(remote.socket, "remoteAddress", {
      value: "203.0.113.7",
      configurable: true,
    });
    expect(resolveBoundaryRole(remote)).toBe("GUEST");
  });
});
