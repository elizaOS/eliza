/**
 * Canonical client-IP normalization for redemption anti-sybil gates.
 *
 * The cloud API only passes trusted proxy headers into this helper, and the
 * service reuses it so direct callers cannot create distinct cap identities
 * with malformed strings. The contract is security-relevant:
 *   - CR/LF injection is rejected outright (header-splitting attempts);
 *   - IPv4 leading-zero and out-of-range octets are rejected so
 *     "192.168.001.1" cannot alias "192.168.1.1" into a second identity;
 *   - IPv6 is canonicalized through URL parsing to a lower-case form;
 *   - anything unrecognized fails closed to `undefined`.
 */

import { describe, expect, test } from "bun:test";

import { normalizeRedemptionClientIp } from "../redemption-client-ip";

describe("normalizeRedemptionClientIp", () => {
  test("returns undefined for null, undefined, empty, and whitespace-only input", () => {
    expect(normalizeRedemptionClientIp(null)).toBeUndefined();
    expect(normalizeRedemptionClientIp(undefined)).toBeUndefined();
    expect(normalizeRedemptionClientIp("")).toBeUndefined();
    expect(normalizeRedemptionClientIp("   ")).toBeUndefined();
  });

  test("rejects CR/LF injection attempts that survive trimming", () => {
    expect(normalizeRedemptionClientIp("1.2.3.4\r\nX-Injected: yes")).toBeUndefined();
    expect(normalizeRedemptionClientIp("1.2.3.4\n5.6.7.8")).toBeUndefined();
    expect(normalizeRedemptionClientIp(" 1.2.3.4\r5.6.7.8 ")).toBeUndefined();
  });

  test("rejects input longer than 128 characters", () => {
    const longV6 = `${"2001:db8:".repeat(20)}1`;
    expect(longV6.length).toBeGreaterThan(128);
    expect(normalizeRedemptionClientIp(longV6)).toBeUndefined();
  });

  test("normalizes a canonical IPv4 address and trims surrounding whitespace", () => {
    expect(normalizeRedemptionClientIp(" 192.168.1.10 ")).toBe("192.168.1.10");
  });

  test("rejects IPv4 octets with leading zeros", () => {
    expect(normalizeRedemptionClientIp("192.168.001.10")).toBeUndefined();
    expect(normalizeRedemptionClientIp("192.168.1.010")).toBeUndefined();
  });

  test("rejects IPv4 octets outside 0-255", () => {
    expect(normalizeRedemptionClientIp("192.168.1.256")).toBeUndefined();
    expect(normalizeRedemptionClientIp("256.1.1.1")).toBeUndefined();
  });

  test("rejects non-numeric or partial IPv4 octets", () => {
    expect(normalizeRedemptionClientIp("192.168.1.x")).toBeUndefined();
    expect(normalizeRedemptionClientIp("192.168.1")).toBeUndefined();
    expect(normalizeRedemptionClientIp("192.168.1.")).toBeUndefined();
    expect(normalizeRedemptionClientIp("192.168.1.1.1")).toBeUndefined();
  });

  test("canonicalizes IPv6 addresses to lower-case", () => {
    expect(normalizeRedemptionClientIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeRedemptionClientIp("FE80::ABCD")).toBe("fe80::abcd");
  });

  test("fails closed on malformed IPv6", () => {
    expect(normalizeRedemptionClientIp("2001:::")).toBeUndefined();
    expect(normalizeRedemptionClientIp("not-an-ip")).toBeUndefined();
  });
});
