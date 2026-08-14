/**
 * Contract coverage for the shared fail-closed numeric parsers in
 * lib/cli-numbers.mjs. The harness is deterministic and pure: every case is
 * an input/throw table over parseCanonicalInt and parseTcpPort, pinning the
 * coercions that motivated the module (issue #19601): Number()/parseInt
 * silently turning "1e4", "0x10", "080", and "8abc" into different valid
 * numbers at port/limit/concurrency call sites.
 */

import { describe, expect, test } from "bun:test";

import { parseCanonicalInt, parseTcpPort } from "../lib/cli-numbers.mjs";

describe("parseCanonicalInt", () => {
  test("accepts canonical decimals inside the bounds", () => {
    expect(parseCanonicalInt("1", "flag")).toBe(1);
    expect(parseCanonicalInt("31337", "flag")).toBe(31337);
    expect(parseCanonicalInt(8, "flag")).toBe(8);
    expect(parseCanonicalInt(" 42 ", "flag")).toBe(42);
    expect(parseCanonicalInt("7", "flag", { min: 7, max: 7 })).toBe(7);
  });

  test("rejects every coercible non-canonical form", () => {
    for (const value of [
      "1e4",
      "0x10",
      "080",
      "8abc",
      "abc",
      "3.9",
      "-3",
      "+3",
      "",
      " ",
      undefined,
      null,
      "Infinity",
      "NaN",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() => parseCanonicalInt(value, "flag")).toThrow(/flag must be/);
    }
  });

  test("enforces the caller's bounds and names the flag in the error", () => {
    expect(() => parseCanonicalInt("0", "workers")).toThrow(/workers must be/);
    expect(() =>
      parseCanonicalInt("33", "workers", { min: 1, max: 32 }),
    ).toThrow(/workers must be a whole decimal integer from 1 to 32/);
  });
});

describe("parseTcpPort", () => {
  test("accepts real ports and rejects the port coercions from #19601", () => {
    expect(parseTcpPort("31338", "ELIZA_TEST_CONSOLE_PORT")).toBe(31338);
    expect(parseTcpPort("1", "p")).toBe(1);
    expect(parseTcpPort("65535", "p")).toBe(65535);
    // "0" logged ":0" then bound an ephemeral port; "1e4" silently bound
    // 10000; "080" printed an unusable URL while probes dialed 80.
    for (const value of ["0", "1e4", "080", "65536", "abc", "", "8080x"]) {
      expect(() => parseTcpPort(value, "p")).toThrow(/p must be/);
    }
  });
});
