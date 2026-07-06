/**
 * useResolvedTtsDefault — the concrete default TTS provider for the current
 * device, agent mode, and *live* runtime capabilities.
 *
 * `useDefaultProviderPresets` gives the platform/mode preference;
 * `resolveDefaultTtsProvider` turns it into a provider that can actually run
 * right now: on-device Kokoro when its engine is staged (probed via
 * `GET /api/tts/local-inference/status`), else Kokoro through Eliza Cloud when a
 * voice session exists, else ElevenLabs when a key is configured, else the
 * browser SpeechSynthesis fallback. Consumed by `useVoiceConfig` (to seed the
 * default when the user hasn't picked a provider) and by `VoiceConfigView` (to
 * label which provider the "Device default" resolves to).
 *
 * The readiness probe is deferred: the on-device check only fires when the
 * platform/mode preference is `local-inference` (desktop/mobile-local), so a
 * web/cloud surface never pays for a probe it wouldn't act on. Until the probe
 * settles the hook returns the non-on-device answer (cloud → ElevenLabs →
 * browser), which is always safe — it can only *upgrade* to on-device Kokoro
 * once the probe confirms a staged voice.
 */

import { useEffect, useState } from "react";
import { isLocalInferenceTtsReady } from "../voice/local-tts-status";
import {
  type PresetPlatform,
  type PresetRuntimeMode,
  resolveDefaultTtsProvider,
  type VoiceCapabilitySnapshot,
  type VoiceProvider,
} from "../voice/voice-provider-defaults";
import {
  type UseDefaultProviderPresetsOptions,
  useDefaultProviderPresets,
} from "./useDefaultProviderPresets";

export interface UseResolvedTtsDefaultOptions
  extends UseDefaultProviderPresetsOptions {
  /** A linked Eliza Cloud session with a working TTS proxy exists. */
  cloudVoiceAvailable: boolean;
  /** The user has configured an ElevenLabs API key. */
  elevenLabsKeyConfigured: boolean;
  /**
   * Test-only override for the on-device Kokoro readiness. Production leaves
   * this undefined and lets the hook probe `/api/tts/local-inference/status`.
   */
  localInferenceTtsReadyOverride?: boolean;
}

export interface UseResolvedTtsDefaultResult {
  /** The concrete default TTS provider to seed / display. */
  provider: VoiceProvider;
  /** Resolved platform that produced the default. */
  platform: PresetPlatform;
  /** Resolved runtime mode that produced the default. */
  runtimeMode: PresetRuntimeMode;
}

export function useResolvedTtsDefault(
  options: UseResolvedTtsDefaultOptions,
): UseResolvedTtsDefaultResult {
  const {
    cloudVoiceAvailable,
    elevenLabsKeyConfigured,
    localInferenceTtsReadyOverride,
    ...presetOptions
  } = options;
  const { platform, runtimeMode } = useDefaultProviderPresets(presetOptions);

  // Only desktop/mobile-local surfaces can host an on-device voice, so the probe
  // (and its state) only matters when the platform/mode preference would pick it.
  const wantsLocalTts =
    (runtimeMode === "local" || runtimeMode === "local-only") &&
    (platform === "desktop" || platform === "mobile");

  const [localTtsReady, setLocalTtsReady] = useState<boolean>(
    localInferenceTtsReadyOverride ?? false,
  );

  useEffect(() => {
    if (localInferenceTtsReadyOverride !== undefined) {
      setLocalTtsReady(localInferenceTtsReadyOverride);
      return;
    }
    if (!wantsLocalTts) {
      setLocalTtsReady(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void isLocalInferenceTtsReady({ signal: controller.signal }).then(
      (ready) => {
        if (!cancelled) setLocalTtsReady(ready);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [wantsLocalTts, localInferenceTtsReadyOverride]);

  const capabilities: VoiceCapabilitySnapshot = {
    localInferenceTtsReady: localTtsReady,
    cloudVoiceAvailable,
    elevenLabsKeyConfigured,
  };

  const provider = resolveDefaultTtsProvider(
    { platform, runtimeMode },
    capabilities,
  );

  return { provider, platform, runtimeMode };
}
