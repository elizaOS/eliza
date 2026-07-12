/**
 * Realtime voice-session guard tests for configuration, consent nonces, and the
 * Phase-1 Opus seam. The Redis boundary is replaced with an in-memory contract
 * double so the tests assert single-use consent behavior without a service.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRedisFactory from "../cache/redis-factory";

// Capture the REAL cloud-bindings surface so the stub keeps every export and can
// be restored. The coverage lane runs all changed files in ONE bun process with
// no `--isolate`, and `mock.module` is process-global with no per-file teardown
// — a stub that (a) drops exports or (b) blinds getCloudAwareEnv() to process.env
// would poison sibling tests (e.g. jwt.test.ts sets JWT_SIGNING_* on process.env
// and needs getCloudAwareEnv() to read it back).
import * as realCloudBindings from "../runtime/cloud-bindings";

const realCloudBindingsExports = { ...realCloudBindings };
const realRedisFactoryExports = { ...realRedisFactory };

const redisState = new Map<string, string>();
const redisCalls: Array<{ op: string; key: string; value?: string; ex?: number }> = [];
let redisConfigured = true;
let redisClient: unknown = {
  async set(key: string, value: string, options?: { ex?: number }) {
    redisCalls.push({ op: "set", key, value, ex: options?.ex });
    redisState.set(key, value);
  },
  async getdel(key: string) {
    redisCalls.push({ op: "getdel", key });
    const value = redisState.get(key);
    redisState.delete(key);
    return value ?? null;
  },
};

mock.module("../cache/redis-factory", () => ({
  buildRedisClient: () => redisClient,
  hasRedisConfig: () => redisConfigured,
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("../runtime/cloud-bindings", () => ({
  ...realCloudBindingsExports,
  // Spread process.env so JWT_SIGNING_* (and anything a sibling test sets) still
  // resolves; only pin the REDIS_URL this suite needs.
  getCloudAwareEnv: () => ({ ...process.env, REDIS_URL: "redis://unit" }),
}));

afterAll(() => {
  mock.module("../cache/redis-factory", () => realRedisFactoryExports);
  mock.module("../runtime/cloud-bindings", () => realCloudBindingsExports);
});

const config = await import("./config");
const consent = await import("./consent-nonce");
const opus = await import("./opus-transcode");

describe("voice-session config", () => {
  test("enables realtime only for explicit truthy operator values", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(config.isVoiceRealtimeWsEnabled({ VOICE_REALTIME_WS_ENABLED: value })).toBe(true);
    }
    for (const value of [undefined, "", "0", "false", "enabled", " trueish "]) {
      expect(config.isVoiceRealtimeWsEnabled({ VOICE_REALTIME_WS_ENABLED: value })).toBe(false);
    }
  });

  test("resolves numeric limits with positive integer flooring and defaults", () => {
    expect(
      config.resolveVoiceUsageLimits({
        VOICE_REALTIME_ORG_DAILY_MINUTES: "42.9",
        VOICE_REALTIME_USER_DAILY_MINUTES: "7",
      }),
    ).toEqual({ organizationDailyMinutes: 42, userDailyMinutes: 7 });
    expect(
      config.resolveVoiceUsageLimits({
        VOICE_REALTIME_ORG_DAILY_MINUTES: "-1",
        VOICE_REALTIME_USER_DAILY_MINUTES: "nan",
      }),
    ).toEqual({ organizationDailyMinutes: 600, userDailyMinutes: 120 });
    expect(config.resolveMaxSessions({ VOICE_REALTIME_MAX_SESSIONS: "3.8" })).toBe(3);
    expect(config.resolveMaxSessions({ VOICE_REALTIME_MAX_SESSIONS: "0" })).toBe(200);
    expect(config.resolveElizaModel({ VOICE_REALTIME_ELIZA_MODEL: "  model-a  " })).toBe("model-a");
    expect(config.resolveElizaModel({ VOICE_REALTIME_ELIZA_MODEL: "   " })).toBe("gemma-4-31b");
  });
});

describe("voice-session consent nonce", () => {
  beforeEach(() => {
    redisState.clear();
    redisCalls.length = 0;
    redisConfigured = true;
    redisClient = {
      async set(key: string, value: string, options?: { ex?: number }) {
        redisCalls.push({ op: "set", key, value, ex: options?.ex });
        redisState.set(key, value);
      },
      async getdel(key: string) {
        redisCalls.push({ op: "getdel", key });
        const value = redisState.get(key);
        redisState.delete(key);
        return value ?? null;
      },
    };
    consent.__resetConsentNonceClientForTests();
  });

  afterEach(() => {
    consent.__resetConsentNonceClientForTests();
  });

  test("issues a short-lived nonce and consumes it exactly once for the issuing user", async () => {
    const issued = await consent.issueConsentNonce("user-a");
    expect(issued?.nonce).toMatch(/[0-9a-f-]{36}/);
    expect(Date.parse(issued!.expiresAt)).toBeGreaterThan(Date.now());

    const setCall = redisCalls.find((call) => call.op === "set");
    expect(setCall?.key).toContain("voice-session:consent:user-a:");
    expect(setCall?.ex).toBe(consent.CONSENT_NONCE_TTL_SECONDS);

    expect(await consent.consumeConsentNonce("user-b", issued!.nonce)).toBe(false);
    expect(await consent.consumeConsentNonce("user-a", issued!.nonce)).toBe(true);
    expect(await consent.consumeConsentNonce("user-a", issued!.nonce)).toBe(false);
  });

  test("fails closed when consent cannot be tracked or inputs are empty", async () => {
    redisClient = null;
    consent.__resetConsentNonceClientForTests();
    expect(consent.isConsentStoreConfigured()).toBe(true);
    expect(await consent.issueConsentNonce("user-a")).toBeNull();
    expect(await consent.consumeConsentNonce("user-a", "nonce")).toBe(false);
    await expect(consent.issueConsentNonce("  ")).rejects.toThrow("requires a userId");
    expect(await consent.consumeConsentNonce("", "nonce")).toBe(false);
    expect(await consent.consumeConsentNonce("user-a", "")).toBe(false);

    redisConfigured = false;
    expect(consent.isConsentStoreConfigured()).toBe(false);
  });
});

describe("voice-session opus transcode seam", () => {
  test("reports unavailable and throws explicit direction errors", () => {
    expect(opus.isOpusTranscodeAvailable()).toBe(false);
    expect(() => opus.decodeOpusToPcm16(new Uint8Array([1]))).toThrow(
      opus.OpusTranscodeNotImplementedError,
    );
    expect(() => opus.encodePcm16ToOpus(new Uint8Array([1]))).toThrow("pcm_to_opus");
  });
});
