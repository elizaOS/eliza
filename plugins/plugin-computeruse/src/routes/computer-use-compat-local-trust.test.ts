/** Exercises the real shared trust classifier through the computer-use policy wrapper. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedComputerUseLocalRequest } from "./computer-use-compat-local-trust.js";

function req(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
) {
  return {
    headers,
    socket: { remoteAddress },
  };
}

describe("isTrustedComputerUseLocalRequest", () => {
  const trustEnv = [
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_DEV_AUTH_BYPASS",
    "ELIZA_CLOUD_PROVISIONED",
    "STEWARD_AGENT_TOKEN",
    "ELIZA_API_TOKEN",
    "ELIZAOS_CLOUD_ENABLED",
    "ELIZAOS_CLOUD_API_KEY",
    "NODE_ENV",
  ] as const;
  const originalEnv = Object.fromEntries(
    trustEnv.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    for (const name of trustEnv) delete process.env[name];
  });

  afterEach(() => {
    for (const name of trustEnv) {
      const original = originalEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it("fails closed when the peer address cannot be proven", () => {
    expect(isTrustedComputerUseLocalRequest(req(undefined))).toBe(false);
    expect(isTrustedComputerUseLocalRequest(req(""))).toBe(false);
  });

  it("rejects a non-loopback peer", () => {
    expect(isTrustedComputerUseLocalRequest(req("8.8.8.8"))).toBe(false);
  });

  it("admits a loopback peer with no browser/proxy metadata", () => {
    expect(isTrustedComputerUseLocalRequest(req("127.0.0.1"))).toBe(true);
    expect(isTrustedComputerUseLocalRequest(req("::1"))).toBe(true);
  });

  it("rejects loopback when a proxy client-IP header is present", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { "x-forwarded-for": "8.8.8.8" }),
      ),
    ).toBe(false);
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { "x-original-forwarded-for": "8.8.8.8" }),
      ),
    ).toBe(false);
  });

  it("rejects loopback when Host is not a loopback bind", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { host: "evil.example" }),
      ),
    ).toBe(false);
  });

  it("rejects cross-site fetch metadata", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
  });

  it("accepts bracketed IPv6 loopback origins and rejects remote referrers", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("::1", { host: "[::1]:3000", origin: "http://[::1]:3000" }),
      ),
    ).toBe(true);
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { referer: "https://evil.example/approve" }),
      ),
    ).toBe(false);
  });

  it("uses the agent cloud policy and never honors the dev auth bypass", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isTrustedComputerUseLocalRequest(req("127.0.0.1"))).toBe(true);

    process.env.STEWARD_AGENT_TOKEN = "provisioning-token";
    expect(isTrustedComputerUseLocalRequest(req("127.0.0.1"))).toBe(false);

    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.STEWARD_AGENT_TOKEN;
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedComputerUseLocalRequest(req("127.0.0.1"))).toBe(false);
  });
});
