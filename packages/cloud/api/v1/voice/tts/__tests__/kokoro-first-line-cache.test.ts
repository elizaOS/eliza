/**
 * Unit tests for the Kokoro first-line cache key/flag helper (#14375).
 *
 * Deterministic and DB-free: exercises the pure cache-key mapping, the flag
 * gate, and provider-key parity against the shared `hashCloudCacheKey`. The
 * live serve/populate round-trip through Railway + R2 is covered separately by
 * `voice-kokoro-whisper-live.test.ts` (gated on a live service) — see the PR
 * evidence table.
 */

import { describe, expect, test } from "bun:test";
import {
  fingerprintCloudVoiceSettings,
  hashCloudCacheKey,
} from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { firstSentenceSnip } from "@elizaos/shared/voice/first-sentence-snip";
import {
  buildKokoroCacheKey,
  isKokoroFirstLineCacheEnabled,
  KOKORO_CACHE_SCOPE,
  KOKORO_CODEC,
  KOKORO_SAMPLE_RATE,
  resolveKokoroVoiceRevision,
} from "../kokoro-first-line-cache";

describe("isKokoroFirstLineCacheEnabled — flag gate", () => {
  test("default OFF (unset / empty)", () => {
    expect(isKokoroFirstLineCacheEnabled(undefined)).toBe(false);
    expect(isKokoroFirstLineCacheEnabled(null)).toBe(false);
    expect(isKokoroFirstLineCacheEnabled("")).toBe(false);
    expect(isKokoroFirstLineCacheEnabled("   ")).toBe(false);
  });

  test("falsy literals stay OFF", () => {
    for (const v of ["0", "false", "no", "off", "disabled", "nope"]) {
      expect(isKokoroFirstLineCacheEnabled(v)).toBe(false);
    }
  });

  test("truthy literals turn ON (case/space-insensitive)", () => {
    for (const v of ["1", "true", "yes", "on", "  TRUE ", "Yes", "ON"]) {
      expect(isKokoroFirstLineCacheEnabled(v)).toBe(true);
    }
  });
});

describe("resolveKokoroVoiceRevision", () => {
  test("folds voice, format, and deploy tag into the revision", () => {
    expect(resolveKokoroVoiceRevision("af_heart", "img-abc123")).toBe(
      `kokoro:af_heart:${KOKORO_SAMPLE_RATE}:${KOKORO_CODEC}:img-abc123`,
    );
  });

  test("defaults the deploy tag to 'unpinned' when unset/blank", () => {
    expect(resolveKokoroVoiceRevision("af_bella", undefined)).toBe(
      `kokoro:af_bella:${KOKORO_SAMPLE_RATE}:${KOKORO_CODEC}:unpinned`,
    );
    expect(resolveKokoroVoiceRevision("af_bella", "   ")).toBe(
      `kokoro:af_bella:${KOKORO_SAMPLE_RATE}:${KOKORO_CODEC}:unpinned`,
    );
  });

  test("different deploy tags produce different revisions (rolls the cache)", () => {
    const a = resolveKokoroVoiceRevision("af_heart", "img-v1");
    const b = resolveKokoroVoiceRevision("af_heart", "img-v2");
    expect(a).not.toBe(b);
  });
});

describe("buildKokoroCacheKey", () => {
  test("maps a Kokoro opener onto the shared provider-keyed cache key", () => {
    const snip = firstSentenceSnip("Got it.");
    expect(snip).not.toBeNull();

    const key = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: snip!.normalized,
      imageTag: "img-abc",
    });

    expect(key.provider).toBe("kokoro");
    expect(key.voiceId).toBe("af_heart");
    expect(key.codec).toBe(KOKORO_CODEC);
    expect(key.sampleRate).toBe(KOKORO_SAMPLE_RATE);
    expect(key.scope).toBe(KOKORO_CACHE_SCOPE);
    expect(key.normalizedText).toBe("got it");
    expect(key.voiceRevision).toBe(
      resolveKokoroVoiceRevision("af_heart", "img-abc"),
    );
    // algoVersion is the snip-version constant so a snip-logic change rolls it.
    expect(key.algoVersion).toBe("1");
    expect(key.voiceSettingsFingerprint).toBe(
      fingerprintCloudVoiceSettings({ speed: 1 }),
    );
  });

  test("hashes stably and matches the shared hash contract", () => {
    const key = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-abc",
    });
    // Same inputs → same hash (deterministic).
    const again = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-abc",
    });
    expect(hashCloudCacheKey(key)).toBe(hashCloudCacheKey(again));
  });

  test("provider-keyed MISS: kokoro hash != elevenlabs hash for the same opener", () => {
    const kokoroKey = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-abc",
    });
    // An ElevenLabs key over the same normalized text must not collide — this
    // is the cross-provider safety guard the ElevenLabs path also relies on.
    const elevenHash = hashCloudCacheKey({
      algoVersion: "1",
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      voiceRevision:
        "elevenlabs:EXAVITQu4vr4xnSDxMaL:eleven_flash_v2_5:mp3_44100_128",
      sampleRate: 44100,
      codec: "mp3",
      voiceSettingsFingerprint: fingerprintCloudVoiceSettings({}),
      normalizedText: "got it",
      scope: "global",
    });
    expect(hashCloudCacheKey(kokoroKey)).not.toBe(elevenHash);
  });

  test("different Kokoro voices for the same opener miss each other", () => {
    const heart = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-abc",
    });
    const bella = buildKokoroCacheKey({
      kokoroVoice: "af_bella",
      normalizedText: "got it",
      imageTag: "img-abc",
    });
    expect(hashCloudCacheKey(heart)).not.toBe(hashCloudCacheKey(bella));
  });

  test("a deploy-tag bump changes the hash (image change rolls the cache)", () => {
    const v1 = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-v1",
    });
    const v2 = buildKokoroCacheKey({
      kokoroVoice: "af_heart",
      normalizedText: "got it",
      imageTag: "img-v2",
    });
    expect(hashCloudCacheKey(v1)).not.toBe(hashCloudCacheKey(v2));
  });
});

describe("whole-input opener gating (matches the route's cacheable rule)", () => {
  const isCacheable = (text: string): boolean => {
    const snip = firstSentenceSnip(text);
    return snip !== null && snip.endOffset === text.trimEnd().length;
  };

  test("short whole-input openers are cacheable", () => {
    expect(isCacheable("Got it.")).toBe(true);
    expect(isCacheable("Sure.")).toBe(true);
    expect(isCacheable("No problem!")).toBe(true);
    expect(isCacheable("Got it.  ")).toBe(true); // trailing ws ignored
  });

  test("multi-sentence / trailing-remainder text is NOT cacheable (no concat)", () => {
    expect(
      isCacheable("Got it. Let me pull up your account details now."),
    ).toBe(false);
  });

  test("unterminated text is NOT cacheable", () => {
    expect(isCacheable("Got it")).toBe(false);
  });

  test(">10-word opener is NOT cacheable (snip refuses it)", () => {
    expect(
      isCacheable(
        "Sure, I will go ahead and take care of that whole thing for you.",
      ),
    ).toBe(false);
  });
});
