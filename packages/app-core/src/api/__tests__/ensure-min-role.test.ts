import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMinRole, resolveBoundaryRole } from "../auth.js";

/**
 * Pins the role-aware HTTP boundary helpers (#9948): `resolveBoundaryRole`
 * classifies a caller into a canonical role using the existing trust + token
 * primitives, and `ensureMinRole` ranks that role against a required minimum
 * via core `roleRank`. Both MUST fail closed.
 */

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

const loopbackOwnerReq = () => makeReq({ host: "localhost:2138" });

// A remote caller cannot be a trusted-local request: it targets a loopback
// Host but originates off-box, so `isTrustedLocalRequest` rejects it.
const remoteReq = (headers: http.IncomingHttpHeaders = {}) =>
  makeReq(
    { host: "localhost:2138", "x-forwarded-for": "203.0.113.9", ...headers },
    "203.0.113.9",
  );

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

describe("resolveBoundaryRole", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("classifies a trusted loopback caller as OWNER", () => {
    expect(resolveBoundaryRole(loopbackOwnerReq())).toBe("OWNER");
  });

  it("classifies a remote, tokenless caller as NONE (fail closed)", () => {
    expect(resolveBoundaryRole(remoteReq())).toBe("NONE");
  });

  it("classifies a remote caller presenting the configured token as OWNER", () => {
    const env = { ...process.env, ELIZA_API_TOKEN: "s3cret-owner-token" };
    expect(
      resolveBoundaryRole(
        remoteReq({ authorization: "Bearer s3cret-owner-token" }),
        env,
      ),
    ).toBe("OWNER");
  });

  it("classifies a remote caller presenting the wrong token as NONE", () => {
    const env = { ...process.env, ELIZA_API_TOKEN: "s3cret-owner-token" };
    expect(
      resolveBoundaryRole(
        remoteReq({ authorization: "Bearer wrong-token" }),
        env,
      ),
    ).toBe("NONE");
  });
});

describe("ensureMinRole", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("(a) loopback owner satisfies ensureMinRole('OWNER')", () => {
    expect(ensureMinRole(loopbackOwnerReq(), "OWNER")).toBe(true);
  });

  it("(b) remote no-token fails ensureMinRole('USER') (fail closed)", () => {
    expect(ensureMinRole(remoteReq(), "USER")).toBe(false);
  });

  it("(c) owner caller passes every tier at or below OWNER", () => {
    const req = loopbackOwnerReq();
    for (const tier of ["NONE", "GUEST", "USER", "ADMIN", "OWNER"] as const) {
      expect(ensureMinRole(req, tier)).toBe(true);
    }
  });

  it("(c) a NONE caller passes only the NONE minimum; anything above fails", () => {
    const req = remoteReq();
    expect(ensureMinRole(req, "NONE")).toBe(true);
    for (const tier of ["GUEST", "USER", "ADMIN", "OWNER"] as const) {
      expect(ensureMinRole(req, tier)).toBe(false);
    }
  });

  it("honours an explicit env token for a remote caller", () => {
    const env = { ...process.env, ELIZA_API_TOKEN: "owner-tok" };
    const req = remoteReq({ authorization: "Bearer owner-tok" });
    expect(ensureMinRole(req, "OWNER", env)).toBe(true);
    expect(ensureMinRole(req, "USER", env)).toBe(true);
  });
});
