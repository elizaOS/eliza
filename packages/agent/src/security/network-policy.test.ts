/**
 * Unit tests for the SSRF IP/host classifier in `network-policy.ts`. Pure,
 * deterministic, and in-process — no DNS resolution, sockets, or real network;
 * every assertion feeds a fixed string straight to the classifier.
 */
import { describe, expect, it } from "vitest";
import {
  decodeIpv6MappedHex,
  isBlockedPrivateOrLinkLocalIp,
  isLoopbackHost,
  normalizeHostLike,
  normalizeIpForPolicy,
} from "./network-policy.ts";

/**
 * SSRF IP classification. This is the gate that stops an agent-triggered fetch
 * from reaching RFC1918, loopback, link-local (169.254 cloud metadata), or
 * IPv4-mapped-IPv6 disguises of those ranges. Each case below is a real bypass
 * vector — ::ffff:127.0.0.1 and ::ffff:7f00:1 both resolve to loopback and must
 * be blocked, not just the bare 127.0.0.1 literal.
 */

describe("normalizeHostLike", () => {
  it("trims, lowercases, and unwraps [v6] brackets", () => {
    expect(normalizeHostLike("  [::1] ")).toBe("::1");
    expect(normalizeHostLike("EXAMPLE.COM")).toBe("example.com");
  });
});

describe("decodeIpv6MappedHex", () => {
  it("decodes hextet pairs into dotted IPv4", () => {
    expect(decodeIpv6MappedHex("7f00:1")).toBe("127.0.0.1");
    expect(decodeIpv6MappedHex("a9fe:1")).toBe("169.254.0.1");
    expect(decodeIpv6MappedHex("zzzz:1")).toBeNull();
  });
});

describe("normalizeIpForPolicy", () => {
  it("unwraps IPv4-mapped IPv6 (dotted and hex) to the IPv4 literal", () => {
    expect(normalizeIpForPolicy("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIpForPolicy("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIpForPolicy("10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIpForPolicy("::1%eth0")).toBe("::1"); // scope id stripped
  });
});

describe("isBlockedPrivateOrLinkLocalIp", () => {
  it("blocks private, loopback, link-local, and mapped disguises", () => {
    for (const ip of [
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata endpoint
      "0.0.0.0",
      "::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      expect(isBlockedPrivateOrLinkLocalIp(ip)).toBe(true);
    }
  });

  it("allows ordinary public IPs", () => {
    expect(isBlockedPrivateOrLinkLocalIp("8.8.8.8")).toBe(false);
    expect(isBlockedPrivateOrLinkLocalIp("1.1.1.1")).toBe(false);
    expect(isBlockedPrivateOrLinkLocalIp("172.32.0.1")).toBe(false); // just outside RFC1918
  });
});

describe("isLoopbackHost", () => {
  it("treats localhost, ::1, and all of 127/8 as loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.5.6.7")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("does not loopback-match hostnames that merely prefix with 127", () => {
    expect(isLoopbackHost("127somehost.example.com")).toBe(false);
    expect(isLoopbackHost("8.8.8.8")).toBe(false);
  });
});
