/**
 * Unit test suite for the private network host predicate. Deterministic
 * pure-function tests verifying strict IPv4/IPv6 classification, bracket syntax
 * validation, invalid octets, and deceptive hostname suffix boundaries.
 */
import { describe, expect, it } from "vitest";
import { isPrivateNetworkHost } from "./private-network-host.js";

describe("isPrivateNetworkHost", () => {
  describe("localhost and loopback", () => {
    it("recognizes localhost and subdomains", () => {
      expect(isPrivateNetworkHost("localhost")).toBe(true);
      expect(isPrivateNetworkHost("app.localhost")).toBe(true);
      expect(isPrivateNetworkHost("sub.domain.localhost")).toBe(true);
      expect(isPrivateNetworkHost("LOCALHOST")).toBe(true);
      expect(isPrivateNetworkHost(" LocalHost ")).toBe(true);
    });

    it("recognizes IPv4 loopback (127.0.0.0/8)", () => {
      expect(isPrivateNetworkHost("127.0.0.1")).toBe(true);
      expect(isPrivateNetworkHost("127.1.2.3")).toBe(true);
      expect(isPrivateNetworkHost("127.0.0.255")).toBe(true);
      expect(isPrivateNetworkHost("127.255.255.254")).toBe(true);
    });

    it("recognizes IPv6 loopback (::1) and unspecified (::)", () => {
      expect(isPrivateNetworkHost("::1")).toBe(true);
      expect(isPrivateNetworkHost("[::1]")).toBe(true);
      expect(isPrivateNetworkHost("::")).toBe(true);
      expect(isPrivateNetworkHost("[::]")).toBe(true);
      expect(isPrivateNetworkHost("0:0:0:0:0:0:0:1")).toBe(true);
      expect(isPrivateNetworkHost("[0:0:0:0:0:0:0:1]")).toBe(true);
    });
  });

  describe("RFC 1918 and LAN IPv4 ranges", () => {
    it("recognizes 10.0.0.0/8", () => {
      expect(isPrivateNetworkHost("10.0.0.1")).toBe(true);
      expect(isPrivateNetworkHost("10.0.0.5")).toBe(true);
      expect(isPrivateNetworkHost("10.255.255.255")).toBe(true);
    });

    it("recognizes 172.16.0.0/12 (172.16.x - 172.31.x)", () => {
      expect(isPrivateNetworkHost("172.16.0.1")).toBe(true);
      expect(isPrivateNetworkHost("172.16.5.4")).toBe(true);
      expect(isPrivateNetworkHost("172.24.10.20")).toBe(true);
      expect(isPrivateNetworkHost("172.31.255.1")).toBe(true);
      expect(isPrivateNetworkHost("172.31.255.255")).toBe(true);
    });

    it("recognizes 192.168.0.0/16", () => {
      expect(isPrivateNetworkHost("192.168.0.1")).toBe(true);
      expect(isPrivateNetworkHost("192.168.1.1")).toBe(true);
      expect(isPrivateNetworkHost("192.168.255.255")).toBe(true);
    });

    it("recognizes CGNAT / Tailscale (100.64.0.0/10)", () => {
      expect(isPrivateNetworkHost("100.64.0.1")).toBe(true);
      expect(isPrivateNetworkHost("100.100.50.25")).toBe(true);
      expect(isPrivateNetworkHost("100.127.255.254")).toBe(true);
    });

    it("recognizes IPv4 link-local (169.254.0.0/16)", () => {
      expect(isPrivateNetworkHost("169.254.0.1")).toBe(true);
      expect(isPrivateNetworkHost("169.254.169.254")).toBe(true);
    });
  });

  describe("IPv6 ULA and link-local ranges", () => {
    it("recognizes Unique Local Addresses (ULA: fc00::/7)", () => {
      expect(isPrivateNetworkHost("fc00::")).toBe(true);
      expect(isPrivateNetworkHost("fc00::1")).toBe(true);
      expect(isPrivateNetworkHost("[fc00::1]")).toBe(true);
      expect(isPrivateNetworkHost("fd00::1")).toBe(true);
      expect(isPrivateNetworkHost("[fd00::1]")).toBe(true);
      expect(isPrivateNetworkHost("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateNetworkHost("[fd12:3456:789a::1]")).toBe(true);
    });

    it("recognizes Link-Local addresses (fe80::/10)", () => {
      expect(isPrivateNetworkHost("fe80::")).toBe(true);
      expect(isPrivateNetworkHost("fe80::1")).toBe(true);
      expect(isPrivateNetworkHost("[fe80::1]")).toBe(true);
      expect(isPrivateNetworkHost("fe90::1")).toBe(true);
      expect(isPrivateNetworkHost("fea0::1")).toBe(true);
      expect(isPrivateNetworkHost("feb0::1")).toBe(true);
      expect(isPrivateNetworkHost("fe80::200:5efe:10.0.0.1")).toBe(true);
      expect(isPrivateNetworkHost("[fe80::200:5efe:10.0.0.1]")).toBe(true);
    });

    it("recognizes IPv4-mapped IPv6 private addresses", () => {
      expect(isPrivateNetworkHost("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateNetworkHost("[::ffff:127.0.0.1]")).toBe(true);
      expect(isPrivateNetworkHost("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateNetworkHost("[::ffff:192.168.1.1]")).toBe(true);
    });
  });

  describe("domain suffixes", () => {
    it("recognizes .local and .internal mDNS / local domain suffixes", () => {
      expect(isPrivateNetworkHost("mybox.local")).toBe(true);
      expect(isPrivateNetworkHost("sub.host.local")).toBe(true);
      expect(isPrivateNetworkHost("svc.internal")).toBe(true);
      expect(isPrivateNetworkHost("cluster.k8s.internal")).toBe(true);
      expect(isPrivateNetworkHost(" MyBox.Local ")).toBe(true);
    });
  });

  describe("invalid octets and malformed IP addresses", () => {
    it("rejects invalid IPv4 octets (> 255)", () => {
      expect(isPrivateNetworkHost("10.999.999.999")).toBe(false);
      expect(isPrivateNetworkHost("127.0.0.256")).toBe(false);
      expect(isPrivateNetworkHost("192.168.1.999")).toBe(false);
      expect(isPrivateNetworkHost("172.16.1.999")).toBe(false);
      expect(isPrivateNetworkHost("100.64.0.256")).toBe(false);
    });

    it("rejects malformed IPv4 structure", () => {
      expect(isPrivateNetworkHost("10.0.0")).toBe(false);
      expect(isPrivateNetworkHost("10.0.0.1.1")).toBe(false);
      expect(isPrivateNetworkHost("10.0.0.01")).toBe(false);
      expect(isPrivateNetworkHost("10.0.0.a")).toBe(false);
    });

    it("rejects malformed IPv6 structure", () => {
      expect(isPrivateNetworkHost("fe80:::1")).toBe(false);
      expect(isPrivateNetworkHost("::1::1")).toBe(false);
      expect(isPrivateNetworkHost("1:2:3:4:5:6:7:8:9")).toBe(false);
      expect(isPrivateNetworkHost("fe80:zzzz::1")).toBe(false);
    });

    it("rejects empty and whitespace strings", () => {
      expect(isPrivateNetworkHost("")).toBe(false);
      expect(isPrivateNetworkHost("   ")).toBe(false);
    });
  });

  describe("bracket validation and mismatched brackets", () => {
    it("rejects unmatched brackets", () => {
      expect(isPrivateNetworkHost("[::1")).toBe(false);
      expect(isPrivateNetworkHost("::1]")).toBe(false);
      expect(isPrivateNetworkHost("[fe80::1")).toBe(false);
      expect(isPrivateNetworkHost("fe80::1]")).toBe(false);
      expect(isPrivateNetworkHost("[10.0.0.1")).toBe(false);
      expect(isPrivateNetworkHost("10.0.0.1]")).toBe(false);
      expect(isPrivateNetworkHost("[localhost")).toBe(false);
      expect(isPrivateNetworkHost("localhost]")).toBe(false);
    });

    it("rejects brackets around non-IPv6 targets", () => {
      expect(isPrivateNetworkHost("[10.0.0.1]")).toBe(false);
      expect(isPrivateNetworkHost("[192.168.1.1]")).toBe(false);
      expect(isPrivateNetworkHost("[localhost]")).toBe(false);
      expect(isPrivateNetworkHost("[mybox.local]")).toBe(false);
      expect(isPrivateNetworkHost("[10.999.999.999]")).toBe(false);
    });

    it("rejects malformed bracket forms", () => {
      expect(isPrivateNetworkHost("[[::1]]")).toBe(false);
      expect(isPrivateNetworkHost("[]")).toBe(false);
      expect(isPrivateNetworkHost("[::1]extra")).toBe(false);
      expect(isPrivateNetworkHost("prefix[::1]")).toBe(false);
    });
  });

  describe("deceptive hostname suffixes and public hosts", () => {
    it("rejects deceptive private IP and localhost hostname prefixes", () => {
      expect(isPrivateNetworkHost("10.0.0.1.example.com")).toBe(false);
      expect(isPrivateNetworkHost("127.0.0.1.nip.io")).toBe(false);
      expect(isPrivateNetworkHost("192.168.1.1.evil.com")).toBe(false);
      expect(isPrivateNetworkHost("172.16.0.1.attacker.com")).toBe(false);
      expect(isPrivateNetworkHost("localhost.example.com")).toBe(false);
      expect(isPrivateNetworkHost("localhost.attacker.com")).toBe(false);
    });

    it("rejects deceptive domain suffixes and partial matches", () => {
      expect(isPrivateNetworkHost("mybox.local.example.com")).toBe(false);
      expect(isPrivateNetworkHost("svc.internal.example.com")).toBe(false);
      expect(isPrivateNetworkHost("evil-localhost")).toBe(false);
      expect(isPrivateNetworkHost("evil-local")).toBe(false);
      expect(isPrivateNetworkHost("evil-internal")).toBe(false);
      expect(isPrivateNetworkHost("notlocalhost")).toBe(false);
      expect(isPrivateNetworkHost("local.example.com")).toBe(false);
    });

    it("rejects public IPv4 and IPv6 addresses", () => {
      expect(isPrivateNetworkHost("8.8.8.8")).toBe(false);
      expect(isPrivateNetworkHost("1.1.1.1")).toBe(false);
      expect(isPrivateNetworkHost("172.15.255.1")).toBe(false);
      expect(isPrivateNetworkHost("172.32.0.1")).toBe(false);
      expect(isPrivateNetworkHost("100.63.255.255")).toBe(false);
      expect(isPrivateNetworkHost("100.128.0.1")).toBe(false);
      expect(isPrivateNetworkHost("2001:db8::1")).toBe(false);
      expect(isPrivateNetworkHost("[2001:db8::1]")).toBe(false);
      expect(isPrivateNetworkHost("2607:f8b0:4005:805::200e")).toBe(false);
      expect(isPrivateNetworkHost("::ffff:8.8.8.8")).toBe(false);
      expect(isPrivateNetworkHost("[::ffff:8.8.8.8]")).toBe(false);
      expect(isPrivateNetworkHost("example.com")).toBe(false);
    });
  });
});
