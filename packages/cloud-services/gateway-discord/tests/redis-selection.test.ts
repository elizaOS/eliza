/**
 * Selection-logic regression tests for GatewayManager's Redis initialization.
 *
 * Wave 4a added a `MOCK_REDIS=1` opt-in. These tests pin the priority so the
 * opt-in does not shadow real Upstash creds when unset:
 *
 *   1. MOCK_REDIS=1                                   → MockUpstashRedis
 *   2. config.redisUrl + config.redisToken           → real UpstashRedis
 *   3. KV_REST_API_URL + KV_REST_API_TOKEN env vars  → Redis.fromEnv() (Upstash)
 *   4. config.redisUrl only (no token)               → null + warning
 *   5. nothing                                        → null
 *
 * The GatewayManager constructor only assigns `this.redis` — it does not
 * start polls, fetch, or open sockets — so we can read the private field
 * directly via a typed cast.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Redis as UpstashRedis } from "@upstash/redis";
import { GatewayManager } from "../src/gateway-manager";
import { MockUpstashRedis } from "../src/mock-redis";

const PREV = {
  MOCK_REDIS: process.env.MOCK_REDIS,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
};

function clearEnv() {
  delete process.env.MOCK_REDIS;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

beforeEach(() => {
  clearEnv();
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const baseConfig = {
  podName: "test-pod",
  elizaCloudUrl: "http://localhost:0",
  gatewayBootstrapSecret: "test-secret",
  project: "test",
};

function getRedis(manager: GatewayManager): unknown {
  return (manager as unknown as { redis: unknown }).redis;
}

describe("GatewayManager Redis selection", () => {
  test("MOCK_REDIS=1 → MockUpstashRedis (even when config + env Upstash set)", () => {
    process.env.MOCK_REDIS = "1";
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "ignored";
    const manager = new GatewayManager({
      ...baseConfig,
      redisUrl: "https://example.upstash.io",
      redisToken: "ignored",
    });
    expect(getRedis(manager)).toBeInstanceOf(MockUpstashRedis);
  });

  test("config.redisUrl + redisToken (no MOCK_REDIS) → real UpstashRedis", () => {
    const manager = new GatewayManager({
      ...baseConfig,
      redisUrl: "https://example.upstash.io",
      redisToken: "real-token",
    });
    expect(getRedis(manager)).toBeInstanceOf(UpstashRedis);
  });

  test("env KV_REST_API_URL + token only → Redis.fromEnv (UpstashRedis)", () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "real-token";
    const manager = new GatewayManager({ ...baseConfig });
    expect(getRedis(manager)).toBeInstanceOf(UpstashRedis);
  });

  test("config.redisUrl with no token and no env creds → null (warn + skip)", () => {
    const manager = new GatewayManager({
      ...baseConfig,
      redisUrl: "https://example.upstash.io",
    });
    expect(getRedis(manager)).toBeNull();
  });

  test("nothing set → null", () => {
    const manager = new GatewayManager({ ...baseConfig });
    expect(getRedis(manager)).toBeNull();
  });
});
