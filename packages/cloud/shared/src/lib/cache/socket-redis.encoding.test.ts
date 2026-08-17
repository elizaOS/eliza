/**
 * Malformed Redis URL password percent-encoding must not throw.
 * decodeURIComponent("%") used to crash parseRedisUrl.
 */

import { describe, expect, test } from "bun:test";
import { decodeRedisUrlPassword, parseRedisUrl } from "./socket-redis";

describe("decodeRedisUrlPassword", () => {
  test("keeps the raw text for a lone %", () => {
    expect(() => decodeRedisUrlPassword("%")).not.toThrow();
    expect(decodeRedisUrlPassword("%")).toBe("%");
  });

  test("keeps the raw text for %ZZ", () => {
    expect(decodeRedisUrlPassword("%ZZ")).toBe("%ZZ");
  });

  test("keeps the raw text for truncated UTF-8", () => {
    expect(decodeRedisUrlPassword("%E0%A4%A")).toBe("%E0%A4%A");
  });

  test("still decodes a valid %20 password", () => {
    expect(decodeRedisUrlPassword("p%20ss")).toBe("p ss");
  });
});

describe("parseRedisUrl password encoding", () => {
  test("double-encoded lone % password does not throw", () => {
    expect(() => parseRedisUrl("redis://:%25@localhost")).not.toThrow();
    expect(parseRedisUrl("redis://:%25@localhost").password).toBe("%");
  });
});
