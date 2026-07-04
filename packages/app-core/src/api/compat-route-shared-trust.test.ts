/**
 * Verifies that app-core's `isTrustedLocalRequest` wrapper wires the correct
 * policy gates into the shared trust classifier, using real
 * http.IncomingMessage fakes with spoofable Host / X-Forwarded-For headers.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedLocalRequest } from "./compat-route-shared.js";

/**
 * Pins that app-core's `isTrustedLocalRequest` wrapper binds its exact policy
 * gates to the canonical `@elizaos/shared` parser: cloudCheck "env"
 * (raw ELIZA_CLOUD_PROVISIONED), ELIZA_REQUIRE_LOCAL_AUTH honoured, and the
 * dev-auth bypass enabled. If the wrapper drops a gate or swaps cloudCheck to
 * "container", these assertions break.
 */

function makeReq(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
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
  "NODE_ENV",
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("app-core isTrustedLocalRequest wrapper (policy gates)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("trusts a bare loopback request when no gate is set", () => {
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("ELIZA_REQUIRE_LOCAL_AUTH=1 denies trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("ELIZA_DEV_AUTH_BYPASS=1 + NODE_ENV=development restores trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("cloudCheck=env: bare ELIZA_CLOUD_PROVISIONED=1 denies trust (no token needed)", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
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
    expect(isTrustedLocalRequest(makeReq({ host: "127.0.0.1.evil.com" }))).toBe(
      false,
    );
  });
});
