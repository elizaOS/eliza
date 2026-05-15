/**
 * W3-8 — TTS cache-key parity test (cloud side).
 *
 * Verifies that `hashCloudCacheKey` (cloud, Cloudflare Workers side) produces
 * the exact same sha256 as the reference hash over 200 randomised inputs.
 *
 * The reference hash is the documented algorithm:
 *   sha256([algoVersion, provider, voiceId, voiceRevision, sampleRate, codec,
 *           voiceSettingsFingerprint, normalizedText].join("|"))
 *
 * This ensures the local `hashCacheKey` and cloud `hashCloudCacheKey` remain
 * in sync — bumping the field set or join order on either side would fail
 * this test.
 */

import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  fingerprintCloudVoiceSettings,
  hashCloudCacheKey,
  type CloudFirstLineCacheKey,
} from "../tts-first-line-cache";

const PROVIDERS = ["kokoro", "omnivoice", "edge-tts", "elevenlabs", "cloud"] as const;
const CODECS = ["mp3", "opus", "wav", "pcm_f32", "ogg"] as const;
const SAMPLE_RATES = [16000, 24000, 44100, 48000] as const;

function randomString(len = 8): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

function randomElement<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

/**
 * Reference hash — identical to the documented algorithm in both
 * `hashCacheKey` (local, first-line-cache.ts) and `hashCloudCacheKey`.
 * Scope is NOT included in the hash (it is a separate lookup dimension).
 */
function referenceHash(
  algoVersion: string,
  provider: string,
  voiceId: string,
  voiceRevision: string,
  sampleRate: number,
  codec: string,
  voiceSettingsFingerprint: string,
  normalizedText: string,
): string {
  const parts = [
    algoVersion,
    provider,
    voiceId,
    voiceRevision,
    String(sampleRate),
    codec,
    voiceSettingsFingerprint,
    normalizedText,
  ].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex");
}

describe("hashCloudCacheKey parity — 200 randomised inputs", () => {
  test("matches reference hash for all random inputs", () => {
    const failures: string[] = [];

    for (let i = 0; i < 200; i++) {
      const algoVersion = randomElement(["1", "2", "v1"]);
      const provider = randomElement(PROVIDERS);
      const voiceId = randomString(12);
      const voiceRevision = randomString(64);
      const sampleRate = randomElement(SAMPLE_RATES);
      const codec = randomElement(CODECS);
      const voiceSettingsFingerprint = fingerprintCloudVoiceSettings({
        stability: Math.random(),
        style: Math.random(),
      });
      const normalizedText = (randomString(20).replace(/\d/g, " ").trim() || "a");
      const scope = Math.random() > 0.5 ? "global" : `org:${randomString(8)}`;

      const key: CloudFirstLineCacheKey = {
        algoVersion,
        provider,
        voiceId,
        voiceRevision,
        sampleRate,
        codec: codec as CloudFirstLineCacheKey["codec"],
        voiceSettingsFingerprint,
        normalizedText,
        scope,
      };

      const computed = hashCloudCacheKey(key);
      const ref = referenceHash(
        algoVersion,
        provider,
        voiceId,
        voiceRevision,
        sampleRate,
        codec,
        voiceSettingsFingerprint,
        normalizedText,
      );

      if (computed !== ref) {
        failures.push(`i=${i}: computed=${computed.slice(0, 8)} ref=${ref.slice(0, 8)}`);
      }
    }

    expect(failures).toHaveLength(0);
  });

  test("scope does NOT affect the hash (lookup-only dimension)", () => {
    // Two keys identical except scope must hash the same.
    const base = {
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision: "rev-aaaa",
      sampleRate: 44100,
      codec: "mp3" as const,
      voiceSettingsFingerprint: fingerprintCloudVoiceSettings({}),
      normalizedText: "got it",
    };
    const globalHash = hashCloudCacheKey({ ...base, scope: "global" });
    const orgHash = hashCloudCacheKey({ ...base, scope: "org:abc123" });
    expect(globalHash).toBe(orgHash);

    // And the hash matches the reference (no scope in the input).
    const ref = referenceHash(
      base.algoVersion,
      base.provider,
      base.voiceId,
      base.voiceRevision,
      base.sampleRate,
      base.codec,
      base.voiceSettingsFingerprint,
      base.normalizedText,
    );
    expect(globalHash).toBe(ref);
  });

  test("cross-provider MISS: kokoro hash != elevenlabs hash for same text", () => {
    const fp = fingerprintCloudVoiceSettings({});
    const normalizedText = "got it";

    const kokoroHash = hashCloudCacheKey({
      algoVersion: "1",
      provider: "kokoro",
      voiceId: "af_bella",
      voiceRevision: "ko-rev-1",
      sampleRate: 24000,
      codec: "opus",
      voiceSettingsFingerprint: fp,
      normalizedText,
      scope: "global",
    });

    const elevenHash = hashCloudCacheKey({
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision: "el-rev-1",
      sampleRate: 44100,
      codec: "mp3",
      voiceSettingsFingerprint: fp,
      normalizedText,
      scope: "global",
    });

    // Different providers produce different hashes for the same text.
    // This is the cloud-side F3 regression guard.
    expect(kokoroHash).not.toBe(elevenHash);
  });

  test("all 5 providers produce distinct hashes for the same text+settings", () => {
    const fp = fingerprintCloudVoiceSettings({});
    const text = "sure thing";
    const hashes = PROVIDERS.map((p) =>
      hashCloudCacheKey({
        algoVersion: "1",
        provider: p,
        voiceId: `${p}-voice`,
        voiceRevision: `${p}-rev`,
        sampleRate: 24000,
        codec: "mp3",
        voiceSettingsFingerprint: fp,
        normalizedText: text,
        scope: "global",
      }),
    );

    const unique = new Set(hashes);
    expect(unique.size).toBe(PROVIDERS.length);
  });
});
