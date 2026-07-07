import { describe, expect, it } from "vitest";
import type { VoiceConfig } from "../api/client-types-config";
import { resolveEffectiveVoiceConfig } from "./voice-chat-types";

/**
 * Regression coverage for the ASR-provider default in
 * {@link resolveEffectiveVoiceConfig} (voice-live PWA fix).
 *
 * The resolver upgrades the TTS `provider` to `eliza-cloud` when the agent is
 * cloud-connected but no explicit provider was stored. It previously left the
 * ASR side (`asr.provider`) untouched, so a cloud-connected agent whose config
 * carried no explicit ASR provider got a NULL `asr.provider`. `shouldUseCloudAsr`
 * then read `undefined`, the composer mic's `startCloudRecognition` early-returned,
 * and capture fell through to the browser SpeechRecognition path, unavailable in
 * an installed iOS PWA, so the mic did nothing at all ("voice fully cooked").
 *
 * The fix mirrors the TTS cloud-upgrade for ASR: seed `asr.provider =
 * "eliza-cloud"` when cloud is connected and no explicit provider was set, never
 * override an explicit stored provider, and stay undefined when cloud is not
 * connected so the local/desktop defaults keep resolving downstream.
 */
describe("resolveEffectiveVoiceConfig - ASR provider default", () => {
  it("seeds asr.provider = eliza-cloud when cloud-connected and asr is unset (the fix)", () => {
    const config: VoiceConfig = {}; // no provider, no asr: a fresh cloud agent

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: true,
    });

    expect(resolved).not.toBeNull();
    // TTS provider upgraded to cloud (existing behavior) ...
    expect(resolved?.provider).toBe("eliza-cloud");
    // ... and ASR provider is now seeded to cloud too (the fix) so the composer
    // mic's shouldUseCloudAsr() picks the /api/asr/cloud WAV path instead of the
    // dead browser recognizer on the iOS PWA.
    expect(resolved?.asr?.provider).toBe("eliza-cloud");
  });

  it("carries the asr default through the elevenlabs return path too", () => {
    const config: VoiceConfig = {
      provider: "elevenlabs",
      elevenlabs: { voiceId: "abc" },
    };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: true,
    });

    expect(resolved?.provider).toBe("elevenlabs");
    // Even when TTS is elevenlabs, ASR still defaults to cloud when connected;
    // the two layers are chosen independently.
    expect(resolved?.asr?.provider).toBe("eliza-cloud");
  });

  it("does NOT override an explicit stored asr.provider (respects a local-inference user)", () => {
    const config: VoiceConfig = {
      asr: { provider: "local-inference" },
    };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: true,
    });

    // An explicit user/device choice wins; the cloud upgrade only fills a gap.
    expect(resolved?.asr?.provider).toBe("local-inference");
  });

  it("preserves an explicit asr.modelId when defaulting the provider", () => {
    const config: VoiceConfig = {
      // provider unset, but a modelId hint is carried on the asr object
      asr: {
        provider: undefined as unknown as "eliza-cloud",
        modelId: "whisper-1",
      },
    };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: true,
    });

    expect(resolved?.asr?.provider).toBe("eliza-cloud");
    expect(resolved?.asr?.modelId).toBe("whisper-1");
  });

  it("leaves asr unset when cloud is NOT connected (local/desktop defaults resolve downstream)", () => {
    const config: VoiceConfig = {
      provider: "edge",
      edge: { voice: "en-US" },
    };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: false,
    });

    // Without a cloud session there is no cloud STT to seed; the device+mode
    // default (pickDefaultVoiceProvider) resolves the ASR provider elsewhere.
    expect(resolved?.asr).toBeUndefined();
  });

  it("keeps returning null when there is no resolvable TTS provider and no cloud", () => {
    // No provider hints + not cloud-connected: still null (unchanged contract).
    expect(
      resolveEffectiveVoiceConfig({}, { cloudConnected: false }),
    ).toBeNull();
  });
});
