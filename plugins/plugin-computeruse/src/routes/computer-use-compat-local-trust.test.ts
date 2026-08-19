/**
 * Deterministic auth-bind coverage for computer-use compat local trust.
 * The harness is real (no mocked helper). Origin treated a missing peer
 * address as local and authorized approval routes without a token.
 */
import { describe, expect, it } from "bun:test";
import { isTrustedComputerUseLocalRequest } from "./computer-use-compat-local-trust.ts";

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
  });

  it("rejects loopback when Host is not a loopback bind", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { host: "evil.example" }),
      ),
    ).toBe(false);
  });

  it("rejects cross-site and same-site fetch metadata", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", {
          host: "localhost:31337",
          origin: "http://localhost:31337",
          "sec-fetch-site": "same-site",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a different loopback port than Host", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", {
          host: "localhost:31337",
          origin: "http://localhost:5173",
          "sec-fetch-site": "same-site",
        }),
      ),
    ).toBe(false);
  });

  it("rejects same hostname on a different port", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", {
          host: "127.0.0.1:31337",
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(false);
  });

  it("admits an Origin that matches Host including port", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", {
          host: "localhost:31337",
          origin: "http://localhost:31337",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(true);
  });

  it("still admits an originless direct loopback client", () => {
    expect(
      isTrustedComputerUseLocalRequest(
        req("127.0.0.1", { host: "localhost:31337" }),
      ),
    ).toBe(true);
  });
});
