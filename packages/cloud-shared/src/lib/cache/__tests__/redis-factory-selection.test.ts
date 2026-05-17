/**
 * Selection-logic regression tests for `buildRedisClient`.
 *
 * Wave 4a added a `MOCK_REDIS=1` opt-in for tests/CI. These tests pin the
 * factory's resolution order so the opt-in does NOT shadow real Upstash or
 * native REDIS_URL credentials when MOCK_REDIS is unset.
 *
 * Resolution order under test (matches the source comment block):
 *   1. MOCK_REDIS=1               → MockSocketRedis
 *   2. REDIS_URL                  → SocketRedis (native RESP2)
 *   3. KV_REST_API_URL + token    → Upstash REST
 *   4. neither                    → null
 *
 * We don't connect to a real Redis — we feed an explicit `env` argument and
 * assert which adapter type the factory returned.
 */

import { describe, expect, test } from "bun:test";
import { Redis as UpstashRedis } from "@upstash/redis";
import { MockSocketRedis } from "../mock-redis";
import { buildRedisClient } from "../redis-factory";
import { SocketRedis } from "../socket-redis";

describe("buildRedisClient selection", () => {
  test("MOCK_REDIS=1 → MockSocketRedis (even when Upstash + REDIS_URL set)", () => {
    const client = buildRedisClient({
      MOCK_REDIS: "1",
      REDIS_URL: "redis://should-not-be-used",
      KV_REST_API_URL: "https://should-not-be-used.upstash.io",
      KV_REST_API_TOKEN: "ignored",
    });
    expect(client).toBeInstanceOf(MockSocketRedis);
  });

  test("REDIS_URL set, no MOCK_REDIS → SocketRedis (native RESP2)", () => {
    const client = buildRedisClient({
      REDIS_URL: "redis://real-host:6379",
    });
    expect(client).toBeInstanceOf(SocketRedis);
    expect(client).not.toBeInstanceOf(MockSocketRedis);
    expect(client).not.toBeInstanceOf(UpstashRedis);
  });

  test("Upstash creds only, no MOCK_REDIS / REDIS_URL → UpstashRedis", () => {
    const client = buildRedisClient({
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "real-token",
    });
    expect(client).toBeInstanceOf(UpstashRedis);
  });

  test("UPSTASH_REDIS_REST_URL/TOKEN aliases also resolve to Upstash", () => {
    const client = buildRedisClient({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "real-token",
    });
    expect(client).toBeInstanceOf(UpstashRedis);
  });

  test("REDIS_URL wins over Upstash creds when both are set", () => {
    const client = buildRedisClient({
      REDIS_URL: "redis://real-host:6379",
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "real-token",
    });
    expect(client).toBeInstanceOf(SocketRedis);
    expect(client).not.toBeInstanceOf(UpstashRedis);
  });

  test("nothing set → returns null (caller decides)", () => {
    const client = buildRedisClient({});
    expect(client).toBeNull();
  });

  test("MOCK_REDIS unset (empty string) does NOT activate mock", () => {
    const client = buildRedisClient({
      MOCK_REDIS: "",
      REDIS_URL: "redis://real-host:6379",
    });
    expect(client).toBeInstanceOf(SocketRedis);
    expect(client).not.toBeInstanceOf(MockSocketRedis);
  });

  test("MOCK_REDIS=0 does NOT activate mock (only the literal string '1')", () => {
    const client = buildRedisClient({
      MOCK_REDIS: "0",
      REDIS_URL: "redis://real-host:6379",
    });
    expect(client).toBeInstanceOf(SocketRedis);
    expect(client).not.toBeInstanceOf(MockSocketRedis);
  });
});
