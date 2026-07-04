/**
 * Unit coverage for the shared local-trust gate (`loopback-trust.ts`) that both
 * `@elizaos/app-core` and `@elizaos/agent` use to decide whether an inbound HTTP
 * request may bypass auth. Exercises loopback peer detection, proxy-client-header
 * spoofing rejection, Host/Origin/Referer classification, and the per-consumer env
 * policy gates — running the shared host/origin cases under both option bundles to
 * prove identical logic while the divergent cloud/dev-bypass gates are tested apart.
 * Requests are synthesized via a stubbed `http.IncomingMessage`.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLoopbackRemoteAddress,
  isTrustedLocalRequest,
  type LoopbackTrustOptions,
  proxyClientHeaderBlocksLocalTrust,
} from "./loopback-trust.js";

/**
 * The two consumers pin DIFFERENT policy gates. These option bundles mirror
 * exactly what `@elizaos/app-core` and `@elizaos/agent` pass. If a consumer's
 * wrapper ever drops a gate, the per-consumer suites below break.
 */
const APP_CORE_OPTIONS: LoopbackTrustOptions = {
  requireLocalAuthEnv: true,
  devAuthBypassEnv: true,
  cloudCheck: "env",
};
const AGENT_OPTIONS: LoopbackTrustOptions = {
  requireLocalAuthEnv: true,
  devAuthBypassEnv: false,
  cloudCheck: "container",
};

function makeReq(opts: {
  ip?: string;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...(opts.headers ?? {}) };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

const TRUST_ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "NODE_ENV",
] as const;

function clearTrustEnv() {
  for (const key of TRUST_ENV_KEYS) delete process.env[key];
}

describe("isLoopbackRemoteAddress", () => {
  it.each([
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:0:127.0.0.1",
  ])("accepts loopback peer %s", (addr) => {
    expect(isLoopbackRemoteAddress(addr)).toBe(true);
  });

  it.each([
    "10.0.0.8",
    "203.0.113.9",
    "",
    null,
    undefined,
    "192.168.1.1",
  ])("rejects non-loopback peer %s", (addr) => {
    expect(isLoopbackRemoteAddress(addr)).toBe(false);
  });
});

describe("proxyClientHeaderBlocksLocalTrust", () => {
  it("does not block when there are no proxy headers", () => {
    expect(proxyClientHeaderBlocksLocalTrust({ host: "localhost:2138" })).toBe(
      false,
    );
  });

  it.each<[string, http.IncomingHttpHeaders]>([
    ["x-forwarded-for remote", { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }],
    ["forwarded remote", { forwarded: 'for="[::1]", for=203.0.113.8' }],
    ["x-real-ip remote", { "x-real-ip": "198.51.100.4" }],
    ["x-client-ip remote", { "x-client-ip": "198.51.100.5" }],
    ["cf-connecting-ip remote", { "cf-connecting-ip": "2001:db8::1" }],
    ["true-client-ip remote:port", { "true-client-ip": "203.0.113.10:443" }],
    ["suffix -client-ip remote", { "fastly-client-ip": "198.51.100.6" }],
  ])("blocks local trust for %s", (_name, headers) => {
    expect(proxyClientHeaderBlocksLocalTrust(headers)).toBe(true);
  });

  it.each<[string, http.IncomingHttpHeaders]>([
    ["loopback x-forwarded-for", { "x-forwarded-for": "127.0.0.1" }],
    ["loopback forwarded", { forwarded: 'for="[::1]"' }],
    ["neutral unknown", { "x-forwarded-for": "unknown" }],
  ])("does not block local trust for %s", (_name, headers) => {
    expect(proxyClientHeaderBlocksLocalTrust(headers)).toBe(false);
  });
});

describe("isTrustedLocalRequest — shared host/origin classification", () => {
  beforeEach(clearTrustEnv);
  afterEach(clearTrustEnv);

  // These hold for BOTH consumers (gates all off). Run each case under both
  // option bundles to prove the host/origin logic is shared verbatim.
  for (const [label, options] of [
    ["app-core", APP_CORE_OPTIONS],
    ["agent", AGENT_OPTIONS],
  ] as const) {
    describe(`(${label} options)`, () => {
      it("trusts a bare loopback request", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({ headers: { host: "localhost:2138" } }),
            options,
          ),
        ).toBe(true);
      });

      it.each([
        "localhost",
        "localhost:31337",
        "127.0.0.1",
        "127.0.0.1:2138",
        "[::1]:2138",
      ])("trusts loopback Host header %s", (host) => {
        expect(
          isTrustedLocalRequest(makeReq({ headers: { host } }), options),
        ).toBe(true);
      });

      it.each([
        "example.com",
        "example.com:443",
        // DNS-rebinding host: the strict shared parser MUST reject this.
        "127.0.0.1.evil.com",
        "127.evil.com",
        "127.0.0.999",
      ])("rejects non-loopback / spoofed Host header %s", (host) => {
        expect(
          isTrustedLocalRequest(makeReq({ headers: { host } }), options),
        ).toBe(false);
      });

      it("rejects a non-loopback peer address", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({ ip: "10.0.0.8", headers: { host: "localhost:2138" } }),
            options,
          ),
        ).toBe(false);
      });

      it("rejects a spoofed X-Forwarded-For pointing at a remote client", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({
              headers: {
                host: "localhost:2138",
                "x-forwarded-for": "127.0.0.1, 203.0.113.9",
              },
            }),
            options,
          ),
        ).toBe(false);
      });

      it("rejects cross-site sec-fetch-site", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({
              headers: {
                host: "localhost:2138",
                "sec-fetch-site": "cross-site",
              },
            }),
            options,
          ),
        ).toBe(false);
      });

      it("rejects a non-loopback Origin", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({
              headers: {
                host: "localhost:2138",
                origin: "https://evil.example",
              },
            }),
            options,
          ),
        ).toBe(false);
      });

      it("trusts a native-app Origin scheme", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({
              headers: { host: "localhost:2138", origin: "capacitor://app" },
            }),
            options,
          ),
        ).toBe(true);
      });

      it("rejects a non-loopback Referer when no Origin is present", () => {
        expect(
          isTrustedLocalRequest(
            makeReq({
              headers: {
                host: "localhost:2138",
                referer: "https://evil.example/page",
              },
            }),
            options,
          ),
        ).toBe(false);
      });
    });
  }
});

describe("isTrustedLocalRequest — app-core policy gates (cloudCheck=env, dev bypass)", () => {
  beforeEach(clearTrustEnv);
  afterEach(clearTrustEnv);

  const localReq = () => makeReq({ headers: { host: "localhost:2138" } });

  it("ELIZA_REQUIRE_LOCAL_AUTH=1 denies local trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(localReq(), APP_CORE_OPTIONS)).toBe(false);
  });

  it("ELIZA_DEV_AUTH_BYPASS=1 + NODE_ENV=development restores local trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedLocalRequest(localReq(), APP_CORE_OPTIONS)).toBe(true);
  });

  it("ELIZA_DEV_AUTH_BYPASS=1 in production does NOT restore trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "production";
    expect(isTrustedLocalRequest(localReq(), APP_CORE_OPTIONS)).toBe(false);
  });

  it("cloudCheck=env: raw ELIZA_CLOUD_PROVISIONED=1 denies trust (no token needed)", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isTrustedLocalRequest(localReq(), APP_CORE_OPTIONS)).toBe(false);
  });
});

describe("isTrustedLocalRequest — agent policy gates (cloudCheck=container, no dev bypass)", () => {
  beforeEach(clearTrustEnv);
  afterEach(clearTrustEnv);

  const localReq = () => makeReq({ headers: { host: "localhost:2138" } });

  it("ELIZA_REQUIRE_LOCAL_AUTH=1 denies local trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(false);
  });

  it("ELIZA_DEV_AUTH_BYPASS is IGNORED by the agent (no bypass) even in dev", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(false);
  });

  it("cloudCheck=container: ELIZA_CLOUD_PROVISIONED=1 WITHOUT a token does NOT deny trust", () => {
    // isCloudProvisionedContainer requires the flag AND a provisioning token,
    // so the bare flag alone leaves the agent's local trust intact.
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(true);
  });

  it("cloudCheck=container: flag + STEWARD_AGENT_TOKEN denies trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(false);
  });

  it("cloudCheck=container: flag + ELIZA_API_TOKEN denies trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "compat-token";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(false);
  });

  it("cloudCheck=container: flag + cloud-api-key provisioning denies trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    expect(isTrustedLocalRequest(localReq(), AGENT_OPTIONS)).toBe(false);
  });
});

describe("cloudCheck semantics differ between consumers", () => {
  beforeEach(clearTrustEnv);
  afterEach(clearTrustEnv);

  it("bare ELIZA_CLOUD_PROVISIONED=1 denies app-core trust but NOT agent trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const req = makeReq({ headers: { host: "localhost:2138" } });
    expect(isTrustedLocalRequest(req, APP_CORE_OPTIONS)).toBe(false);
    expect(isTrustedLocalRequest(req, AGENT_OPTIONS)).toBe(true);
  });
});
