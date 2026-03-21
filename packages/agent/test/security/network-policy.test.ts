import { describe, expect, test } from "vitest";
import {
  decodeIpv6MappedHex,
  isBlockedPrivateOrLinkLocalIp,
  isLoopbackHost,
  normalizeHostLike,
  normalizeIpForPolicy,
} from "../../src/security/network-policy";

describe("network-policy", () => {
  describe("normalizeIpForPolicy", () => {
    test("passes through plain IPv4", () => {
      expect(normalizeIpForPolicy("8.8.8.8")).toBe("8.8.8.8");
    });

    test("strips IPv6-mapped IPv4 prefix (dotted)", () => {
      expect(normalizeIpForPolicy("::ffff:192.168.1.1")).toBe("192.168.1.1");
    });

    test("strips IPv6-mapped IPv4 prefix (long form)", () => {
      expect(normalizeIpForPolicy("0:0:0:0:0:ffff:192.168.1.1")).toBe(
        "192.168.1.1",
      );
    });

    test("lowercases IPv6", () => {
      const result = normalizeIpForPolicy("FE80::1");
      expect(result).toBe(result.toLowerCase());
    });

    test("strips zone ID suffix", () => {
      const result = normalizeIpForPolicy("fe80::1%eth0");
      expect(result).not.toContain("%");
    });
  });

  describe("isBlockedPrivateOrLinkLocalIp", () => {
    test.each([
      ["10.0.0.1", true],
      ["10.255.255.255", true],
      ["172.16.0.1", true],
      ["172.31.255.255", true],
      ["192.168.0.1", true],
      ["192.168.100.50", true],
      ["127.0.0.1", true],
      ["169.254.1.1", true],
      ["0.0.0.0", true],
      ["8.8.8.8", false],
      ["1.1.1.1", false],
      ["203.0.113.1", false],
    ])("%s → blocked=%s", (ip, expected) => {
      expect(isBlockedPrivateOrLinkLocalIp(ip)).toBe(expected);
    });

    test("blocks IPv6 loopback ::1", () => {
      expect(isBlockedPrivateOrLinkLocalIp("::1")).toBe(true);
    });

    test("blocks IPv6 unspecified ::", () => {
      expect(isBlockedPrivateOrLinkLocalIp("::")).toBe(true);
    });

    test("blocks IPv6 link-local fe80::", () => {
      expect(isBlockedPrivateOrLinkLocalIp("fe80::1")).toBe(true);
    });

    test("blocks IPv6 ULA fc00::/7", () => {
      expect(isBlockedPrivateOrLinkLocalIp("fd12:3456::1")).toBe(true);
    });

    test("allows public IPv6", () => {
      expect(isBlockedPrivateOrLinkLocalIp("2001:4860:4860::8888")).toBe(false);
    });

    test("blocks IPv6-mapped private IPv4", () => {
      expect(isBlockedPrivateOrLinkLocalIp("::ffff:10.0.0.1")).toBe(true);
    });

    test("allows IPv6-mapped public IPv4", () => {
      expect(isBlockedPrivateOrLinkLocalIp("::ffff:8.8.8.8")).toBe(false);
    });
  });

  describe("isLoopbackHost", () => {
    test("localhost is loopback", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
    });

    test("127.0.0.1 is loopback", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
    });

    test("127.0.0.2 is loopback", () => {
      expect(isLoopbackHost("127.0.0.2")).toBe(true);
    });

    test("::1 is loopback", () => {
      expect(isLoopbackHost("::1")).toBe(true);
    });

    test("external host is not loopback", () => {
      expect(isLoopbackHost("example.com")).toBe(false);
    });

    test("8.8.8.8 is not loopback", () => {
      expect(isLoopbackHost("8.8.8.8")).toBe(false);
    });
  });

  describe("normalizeHostLike", () => {
    test("lowercases input", () => {
      expect(normalizeHostLike("Example.COM")).toBe("example.com");
    });

    test("strips IPv6 brackets", () => {
      expect(normalizeHostLike("[::1]")).toBe("::1");
    });

    test("trims whitespace", () => {
      expect(normalizeHostLike("  example.com  ")).toBe("example.com");
    });
  });

  describe("decodeIpv6MappedHex", () => {
    test("decodes two-part hex to IPv4", () => {
      expect(decodeIpv6MappedHex("c0a8:0101")).toBe("192.168.1.1");
    });

    test("decodes single-part hex", () => {
      // Single part means hi=0, lo=parsed value
      const result = decodeIpv6MappedHex("0101");
      expect(result).toBe("0.0.1.1");
    });

    test("returns null for too many parts", () => {
      expect(decodeIpv6MappedHex("c0a8:0101:extra")).toBeNull();
    });

    test("returns null for non-hex input", () => {
      expect(decodeIpv6MappedHex("zzzz:zzzz")).toBeNull();
    });
  });
});
