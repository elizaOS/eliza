import { describe, expect, test } from "bun:test";
import {
  fingerprintCloudVoiceSettings,
  hashCloudCacheKey,
  shouldBypassCloudFirstLineCache,
} from "../tts-first-line-cache";

describe("hashCloudCacheKey", () => {
  test("is deterministic across calls", () => {
    const key = {
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision: "rev-aaaa",
      sampleRate: 44100,
      codec: "mp3" as const,
      voiceSettingsFingerprint: fingerprintCloudVoiceSettings({}),
      normalizedText: "got it",
      scope: "global",
    };
    expect(hashCloudCacheKey(key)).toBe(hashCloudCacheKey(key));
  });

  test("changes when any key field changes (regression: F3 voice-swap safety)", () => {
    const base = {
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision: "rev-aaaa",
      sampleRate: 44100,
      codec: "mp3" as const,
      voiceSettingsFingerprint: fingerprintCloudVoiceSettings({}),
      normalizedText: "got it",
      scope: "global",
    };
    const baseHash = hashCloudCacheKey(base);
    expect(hashCloudCacheKey({ ...base, voiceId: "other" })).not.toBe(baseHash);
    expect(hashCloudCacheKey({ ...base, voiceRevision: "rev-bbbb" })).not.toBe(baseHash);
    expect(hashCloudCacheKey({ ...base, normalizedText: "sure thing" })).not.toBe(baseHash);
    expect(hashCloudCacheKey({ ...base, sampleRate: 24000 })).not.toBe(baseHash);
    expect(hashCloudCacheKey({ ...base, codec: "opus" as const })).not.toBe(baseHash);
    expect(hashCloudCacheKey({ ...base, provider: "kokoro" })).not.toBe(baseHash);
    expect(
      hashCloudCacheKey({
        ...base,
        voiceSettingsFingerprint: fingerprintCloudVoiceSettings({ stability: 0.2 }),
      }),
    ).not.toBe(baseHash);
  });

  test("scope is NOT part of the manifest-key hash but is part of the lookup", () => {
    // Per the schema, lookup is `(key_hash, scope)`; key_hash itself does
    // NOT include scope. This lets us cheaply audit cross-org dedupe
    // opportunities while keeping the per-org lookup isolated.
    const baseGlobal = {
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision: "rev-aaaa",
      sampleRate: 44100,
      codec: "mp3" as const,
      voiceSettingsFingerprint: fingerprintCloudVoiceSettings({}),
      normalizedText: "got it",
      scope: "global",
    };
    const baseOrg = { ...baseGlobal, scope: "org:abc" };
    expect(hashCloudCacheKey(baseGlobal)).toBe(hashCloudCacheKey(baseOrg));
  });
});

describe("fingerprintCloudVoiceSettings", () => {
  test("is order-independent", () => {
    expect(fingerprintCloudVoiceSettings({ stability: 0.5, style: 0.3 })).toBe(
      fingerprintCloudVoiceSettings({ style: 0.3, stability: 0.5 }),
    );
  });

  test("differs when values differ", () => {
    expect(fingerprintCloudVoiceSettings({ stability: 0.5 })).not.toBe(
      fingerprintCloudVoiceSettings({ stability: 0.6 }),
    );
  });

  test("empty / null produce the same baseline fingerprint", () => {
    expect(fingerprintCloudVoiceSettings({})).toBe(fingerprintCloudVoiceSettings(null));
    expect(fingerprintCloudVoiceSettings({})).toBe(fingerprintCloudVoiceSettings(undefined));
  });
});

describe("shouldBypassCloudFirstLineCache", () => {
  test("returns true on explicit forceBypass", () => {
    expect(
      shouldBypassCloudFirstLineCache({ modelId: "eleven_flash_v2_5", forceBypass: true }),
    ).toBe(true);
  });

  test("returns true for realtime models (non-deterministic output)", () => {
    expect(shouldBypassCloudFirstLineCache({ modelId: "eleven_flash_v2_5_realtime" })).toBe(true);
    expect(
      shouldBypassCloudFirstLineCache({
        modelId: "eleven_multilingual_v2_realtime",
      }),
    ).toBe(true);
  });

  test("returns false for default flash model", () => {
    expect(shouldBypassCloudFirstLineCache({ modelId: "eleven_flash_v2_5" })).toBe(false);
    expect(shouldBypassCloudFirstLineCache({ modelId: null })).toBe(false);
  });
});
