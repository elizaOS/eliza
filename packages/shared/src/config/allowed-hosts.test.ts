/**
 * Exercises the real allowed-host environment boundary and its Vite and
 * Capacitor transforms with deterministic host parsing; no network is used.
 */
import { describe, expect, it } from "vitest";
import {
  parseAllowedHostEnv,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
} from "./allowed-hosts.ts";

describe("parseAllowedHostEnv", () => {
  it("treats nullish or empty environment configuration as absent", () => {
    expect(parseAllowedHostEnv(undefined)).toEqual([]);
    expect(parseAllowedHostEnv(null)).toEqual([]);
    expect(parseAllowedHostEnv("  ,  ")).toEqual([]);
  });

  it("canonicalizes bare DNS, IDN, IPv4, and bracketed IPv6 hosts", () => {
    expect(
      parseAllowedHostEnv(
        "Example.COM., münich.example, 127.1, 0x7f000001, [2001:0db8:0:0:0:0:0:1], 2001:db8::1",
      ),
    ).toEqual([
      { host: "example.com", includeSubdomains: false },
      { host: "xn--mnich-kva.example", includeSubdomains: false },
      { host: "127.0.0.1", includeSubdomains: false },
      { host: "[2001:db8::1]", includeSubdomains: false },
    ]);
  });

  it("accepts wildcard and leading-dot DNS patterns", () => {
    expect(parseAllowedHostEnv("*.elizaos.ai, .internal.net")).toEqual([
      { host: "elizaos.ai", includeSubdomains: true },
      { host: "internal.net", includeSubdomains: true },
    ]);
  });

  it("extracts canonical hosts and discards URL or bare-host ports", () => {
    expect(
      parseAllowedHostEnv(
        "https://API.elizaos.ai:8443, localhost:5173, http://[::1]:5173/",
      ),
    ).toEqual([
      { host: "api.elizaos.ai", includeSubdomains: false },
      { host: "localhost", includeSubdomains: false },
      { host: "[::1]", includeSubdomains: false },
    ]);
  });

  it("deduplicates equivalent canonical host patterns", () => {
    expect(
      parseAllowedHostEnv(
        "example.com, EXAMPLE.com., münich.example, xn--mnich-kva.example",
      ),
    ).toEqual([
      { host: "example.com", includeSubdomains: false },
      { host: "xn--mnich-kva.example", includeSubdomains: false },
    ]);
  });

  it.each(["ftp://example.com", "file://example.com"])(
    "rejects unsupported URL protocol %s",
    (value) => {
      expect(() => parseAllowedHostEnv(value)).toThrow(/unsupported protocol/);
    },
  );

  it.each([
    "https://example.com/subpath",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "example.com/subpath",
    "example.com?query=1",
    "example.com#fragment",
  ])("rejects path, query, and fragment syntax in %s", (value) => {
    expect(() => parseAllowedHostEnv(value)).toThrow(/host|host pattern/);
  });

  it.each([
    "https://user@example.com/",
    "https://user:secret@example.com/",
    "https://@example.com/",
    "user@example.com",
    "@example.com",
  ])("rejects embedded credentials in %s", (value) => {
    expect(() => parseAllowedHostEnv(value)).toThrow(
      /credentials|host pattern/,
    );
  });

  it.each([
    "*",
    "foo.*.example.com",
    "*.127.0.0.1",
    "*.[::1]",
    "example.com..",
    "[not-an-ipv6-address]",
    "example.com\t.evil.test",
  ])("rejects unsupported host pattern %s", (value) => {
    expect(() => parseAllowedHostEnv(value)).toThrow(/host pattern/);
  });

  it("fails fast for a cast-only non-string value", () => {
    expect(() => parseAllowedHostEnv(123 as unknown as string)).toThrow();
  });
});

describe("allowed-host consumer transforms", () => {
  it("feeds canonical patterns into Vite and Capacitor formats", () => {
    const patterns = parseAllowedHostEnv("localhost, *.elizaos.ai");
    expect(toViteAllowedHosts(patterns)).toEqual(["localhost", ".elizaos.ai"]);
    expect(toCapacitorAllowNavigation(patterns)).toEqual([
      "localhost",
      "*.elizaos.ai",
    ]);
  });

  it("does not silently turn cast-only arrays into an empty allow-list", () => {
    expect(() =>
      toViteAllowedHosts(null as unknown as readonly never[]),
    ).toThrow();
    expect(() =>
      toCapacitorAllowNavigation(undefined as unknown as readonly never[]),
    ).toThrow();
  });
});
