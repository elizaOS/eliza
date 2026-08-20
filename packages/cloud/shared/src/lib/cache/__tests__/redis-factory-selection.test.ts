/** Verifies direct Redis transport selection without opening network connections. */

import { describe, expect, test } from "bun:test";
import { Redis as UpstashRedis } from "@upstash/redis";
import { buildRedisClient, hasRedisConfig } from "../redis-factory";
import { SocketRedis } from "../socket-redis";

const TCP_URL = "redis://default:test@unreachable.example.test:6379";
const REST_URL = "https://redis-rest.example.test";
const REST_TOKEN = "test-token";

describe("direct Redis transport selection", () => {
  test("missing or blank selection preserves automatic TCP-first behavior", () => {
    for (const directBackend of [undefined, "", "   "]) {
      const env = {
        DIRECT_REDIS_BACKEND: directBackend,
        REDIS_URL: TCP_URL,
        KV_REST_API_URL: REST_URL,
        KV_REST_API_TOKEN: REST_TOKEN,
      };

      expect(buildRedisClient(env)).toBeInstanceOf(SocketRedis);
      expect(hasRedisConfig(env)).toBe(true);
    }
  });

  test("auto preserves TCP-first selection when both transports are configured", () => {
    const client = buildRedisClient({
      DIRECT_REDIS_BACKEND: "auto",
      REDIS_URL: TCP_URL,
      KV_REST_API_URL: REST_URL,
      KV_REST_API_TOKEN: REST_TOKEN,
    });

    expect(client).toBeInstanceOf(SocketRedis);
    expect(
      hasRedisConfig({
        DIRECT_REDIS_BACKEND: "auto",
        REDIS_URL: TCP_URL,
        KV_REST_API_URL: REST_URL,
        KV_REST_API_TOKEN: REST_TOKEN,
      }),
    ).toBe(true);
  });

  test("explicit redis selects the TCP transport", () => {
    const client = buildRedisClient({
      DIRECT_REDIS_BACKEND: "redis",
      REDIS_URL: TCP_URL,
      KV_REST_API_URL: REST_URL,
      KV_REST_API_TOKEN: REST_TOKEN,
    });

    expect(client).toBeInstanceOf(SocketRedis);
  });

  test("explicit redis-rest bypasses an unavailable TCP endpoint", () => {
    const env = {
      DIRECT_REDIS_BACKEND: "redis-rest",
      REDIS_URL: TCP_URL,
      KV_REST_API_URL: REST_URL,
      KV_REST_API_TOKEN: REST_TOKEN,
    };

    expect(buildRedisClient(env)).toBeInstanceOf(UpstashRedis);
    expect(hasRedisConfig(env)).toBe(true);
  });

  test("explicit selection fails closed when the selected backend is unconfigured", () => {
    const restSelectedWithoutRest = {
      DIRECT_REDIS_BACKEND: "redis-rest",
      REDIS_URL: TCP_URL,
    };
    const tcpSelectedWithoutTcp = {
      DIRECT_REDIS_BACKEND: "redis",
      KV_REST_API_URL: REST_URL,
      KV_REST_API_TOKEN: REST_TOKEN,
    };

    expect(buildRedisClient(restSelectedWithoutRest)).toBeNull();
    expect(hasRedisConfig(restSelectedWithoutRest)).toBe(false);
    expect(buildRedisClient(tcpSelectedWithoutTcp)).toBeNull();
    expect(hasRedisConfig(tcpSelectedWithoutTcp)).toBe(false);
  });

  test("whitespace-only selected TCP credentials fail closed without throwing", () => {
    const env = {
      DIRECT_REDIS_BACKEND: "redis",
      REDIS_URL: "  \n\t  ",
    };

    expect(() => buildRedisClient(env)).not.toThrow();
    expect(buildRedisClient(env)).toBeNull();
    expect(hasRedisConfig(env)).toBe(false);
  });

  test("whitespace-only selected REST credentials fail closed without throwing", () => {
    for (const [url, token] of [
      ["   ", REST_TOKEN],
      [REST_URL, " \n "],
      ["\t", "   "],
    ]) {
      const env = {
        DIRECT_REDIS_BACKEND: "redis-rest",
        KV_REST_API_URL: url,
        KV_REST_API_TOKEN: token,
      };

      expect(() => buildRedisClient(env)).not.toThrow();
      expect(buildRedisClient(env)).toBeNull();
      expect(hasRedisConfig(env)).toBe(false);
    }
  });

  test("valid selected credentials are trimmed before client construction", () => {
    const tcpEnv = {
      DIRECT_REDIS_BACKEND: "redis",
      REDIS_URL: `  ${TCP_URL} \n`,
    };
    const restEnv = {
      DIRECT_REDIS_BACKEND: "redis-rest",
      KV_REST_API_URL: `\t${REST_URL}  `,
      KV_REST_API_TOKEN: `  ${REST_TOKEN}\n`,
    };

    expect(buildRedisClient(tcpEnv)).toBeInstanceOf(SocketRedis);
    expect(hasRedisConfig(tcpEnv)).toBe(true);
    expect(buildRedisClient(restEnv)).toBeInstanceOf(UpstashRedis);
    expect(hasRedisConfig(restEnv)).toBe(true);
  });

  test("auto ignores blank TCP credentials and falls through to REST", () => {
    const env = {
      REDIS_URL: "   ",
      KV_REST_API_URL: REST_URL,
      KV_REST_API_TOKEN: REST_TOKEN,
    };

    expect(buildRedisClient(env)).toBeInstanceOf(UpstashRedis);
    expect(hasRedisConfig(env)).toBe(true);
  });

  test("undocumented aliases and noncanonical variants fail closed", () => {
    for (const directBackend of [
      "native-redis",
      "redis-native",
      "rest",
      "upstash",
      "AUTO",
      "Redis",
      "REDIS-REST",
      " auto",
      "redis ",
      " redis-rest ",
      "redis-rets",
      "unknown",
      "redis rest",
    ]) {
      const env = {
        DIRECT_REDIS_BACKEND: directBackend,
        REDIS_URL: TCP_URL,
        KV_REST_API_URL: REST_URL,
        KV_REST_API_TOKEN: REST_TOKEN,
      };

      expect(buildRedisClient(env)).toBeNull();
      expect(hasRedisConfig(env)).toBe(false);
    }
  });
});
