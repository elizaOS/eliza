import { describe, expect, it, spyOn } from "bun:test";
import * as dns from "node:dns";
import {
  assertPublicHttpsEndpoint,
  assertPublicInternetAddress,
  BLOCKED_PUBLIC_ENDPOINT_DNS_SUFFIXES,
  isPublicInternetAddress,
} from "../public-endpoint";
import {
  assertPinnedDnsTransportSupported,
  createPublicInternetLookup,
} from "../public-endpoint-node";

describe("public Internet destination classifier", () => {
  it("rejects IPv4-compatible, translated, and mapped private IPv6 targets", () => {
    for (const address of [
      "::127.0.0.1",
      "::7f00:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:127.0.0.1",
      "::ffff:0:7f00:1",
    ]) {
      expect(isPublicInternetAddress(address, 6), address).toBe(false);
    }
  });

  it("rejects IANA special-purpose IPv4 ranges, not just RFC1918", () => {
    for (const address of [
      "0.0.0.1",
      "100.64.0.1",
      "192.0.0.9",
      "192.0.2.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.88.99.1",
      "192.175.48.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicInternetAddress(address, 4), address).toBe(false);
    }
  });

  it("rejects special-purpose IPv6 while retaining ordinary global unicast", () => {
    for (const address of [
      "::",
      "::1",
      "64:ff9b:1::808:808",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "2620:4f:8000::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fe80::1",
      "ff00::1",
    ]) {
      expect(isPublicInternetAddress(address, 6), address).toBe(false);
    }

    expect(isPublicInternetAddress("8.8.8.8", 4)).toBe(true);
    expect(isPublicInternetAddress("2606:4700:4700::1111", 6)).toBe(true);
    expect(isPublicInternetAddress("::ffff:8.8.8.8", 6)).toBe(true);
    expect(isPublicInternetAddress("64:ff9b::808:808", 6)).toBe(true);
    expect(isPublicInternetAddress("2002:808:808::", 6)).toBe(true);
  });

  it("fails closed on malformed addresses and resolver family mismatches", () => {
    for (const address of [
      "not-an-ip",
      "01.2.3.4",
      "+1.2.3.4",
      "1e0.2.3.4",
      "1..2.3",
      " 8.8.8.8 ",
    ]) {
      expect(isPublicInternetAddress(address), address).toBe(false);
    }
    expect(isPublicInternetAddress("8.8.8.8", 6)).toBe(false);
    expect(isPublicInternetAddress("2606:4700:4700::1111%en0", 6)).toBe(false);
    expect(() =>
      assertPublicInternetAddress("8.8.8.8", 0, "OIDC token endpoint"),
    ).toThrow("OIDC token endpoint must resolve to a public address");
  });
});

describe("connect-time public DNS lookup", () => {
  it("rejects a Happy Eyeballs result when any candidate is non-public", async () => {
    const dnsSpy = spyOn(dns, "lookup").mockImplementation(((
      _hostname,
      _options,
      callback,
    ) => {
      callback(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    }) as typeof dns.lookup);
    try {
      const lookup = createPublicInternetLookup("OIDC token endpoint");
      const error = await new Promise<Error | null>((resolve) => {
        lookup("idp.example.com", { all: true }, (lookupError) =>
          resolve(lookupError),
        );
      });
      expect(error?.message).toBe(
        "OIDC token endpoint must resolve to a public address",
      );
      expect(dnsSpy).toHaveBeenCalledTimes(1);
    } finally {
      dnsSpy.mockRestore();
    }
  });
});

describe("public HTTPS endpoint validator", () => {
  it("rejects local names, credentials, non-HTTPS, and special-use literals", () => {
    for (const endpoint of [
      "http://idp.example.com/token",
      "https://localhost/token",
      "https://localhost./token",
      "https://idp.internal./token",
      "https://idp/token",
      "https://idp.home.arpa/token",
      "https://idp.test/token",
      "https://idp.onion/token",
      "https://idp..example.com/token",
      "https://-idp.example.com/token",
      "https://idp-.example.com/token",
      "https://idp_example.com/token",
      "https://idp.exam\tple.com/token",
      `https://idp.example.com/${"x".repeat(2_048)}`,
      "https://user:secret@idp.example.com/token",
      "https://idp.example.com:0/token",
      "https://192.0.2.1/token",
      "https://127.1/token",
      "https://2130706433/token",
      "https://0x7f000001/token",
      "https://[::7f00:1]/token",
      "https://[::ffff:0:7f00:1]/token",
      "https://[3fff::1]/token",
    ]) {
      expect(
        () => assertPublicHttpsEndpoint(endpoint, "OIDC token endpoint"),
        endpoint,
      ).toThrow("OIDC token endpoint must be a public https URL");
    }
  });

  it("rejects every blocked DNS suffix at apex, subdomain, and trailing-dot apex", () => {
    for (const suffix of BLOCKED_PUBLIC_ENDPOINT_DNS_SUFFIXES) {
      for (const hostname of [suffix, `idp.${suffix}`, `${suffix}.`]) {
        const endpoint = `https://${hostname}/token`;
        expect(
          () => assertPublicHttpsEndpoint(endpoint, "OIDC token endpoint"),
          endpoint,
        ).toThrow("OIDC token endpoint must be a public https URL");
      }
    }
  });

  it("accepts public DNS and literal endpoints", () => {
    expect(
      assertPublicHttpsEndpoint(
        "https://idp.example.com/token",
        "OIDC token endpoint",
      ).href,
    ).toBe("https://idp.example.com/token");
    expect(
      assertPublicHttpsEndpoint("https://8.8.8.8/token", "OIDC token endpoint")
        .href,
    ).toBe("https://8.8.8.8/token");
    expect(
      assertPublicHttpsEndpoint(
        "https://idp.example.com:8443/token",
        "OIDC token endpoint",
      ).port,
    ).toBe("8443");
  });

  it("fails closed explicitly when connect-time pinning is unavailable on Workers", () => {
    const originalRuntime = process.env.STEWARD_RUNTIME;
    process.env.STEWARD_RUNTIME = "workers";
    try {
      expect(() =>
        assertPinnedDnsTransportSupported("OIDC token endpoint"),
      ).toThrow(
        "OIDC token endpoint requires connect-time DNS validation unavailable in Workers",
      );
    } finally {
      if (originalRuntime === undefined) delete process.env.STEWARD_RUNTIME;
      else process.env.STEWARD_RUNTIME = originalRuntime;
    }
  });
});
