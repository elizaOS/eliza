/** Redis URL passwords reject malformed percent-encoding with a typed error. */

import { describe, expect, test } from "bun:test";
import { decodeRedisUrlPassword, parseRedisUrl, RedisUrlUserinfoError } from "./socket-redis";

describe("decodeRedisUrlPassword", () => {
  test.each(["%", "%ZZ", "%E0%A4%A"])("rejects malformed password %s", (password) => {
    expect(() => decodeRedisUrlPassword(password)).toThrow(RedisUrlUserinfoError);
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

  test("rejects malformed password encoding from a Redis URL", () => {
    expect(() => parseRedisUrl("redis://:%@localhost")).toThrow(RedisUrlUserinfoError);
  });
});
