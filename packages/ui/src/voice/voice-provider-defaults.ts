/**
 * Default voice + ASR provider selection.
 *
 * Captures the device+mode matrix the product team specified in the
 * settings "advanced mode" picker design:
 *
 *   - Desktop running a local agent → on-device models
 *     (TTS: `local-inference` / OmniVoice, ASR: `local-inference` / Qwen3-ASR).
 *   - Mobile running a local agent → on-device Kokoro TTS
 *     (TTS: `local-inference`; Kokoro is ~82M params and runs comfortably on
 *     phones — see `selectVoiceBackend({ mobile: true })`). ASR still routes
 *     to Eliza Cloud (`eliza-cloud`) because on-device speech recognition is
 *     heavier than TTS.
 *   - Cloud agents (any device) → always Eliza Cloud.
 *   - Remote-controller surfaces (UI hitting a remote API base) → Eliza
 *     Cloud, same rationale as cloud agents.
 *
 * The picker is intentionally a pure function so it can be unit-tested
 * exhaustively. The React hook wrapper lives in
 * `hooks/useDefaultProviderPresets.ts`.
 */

import type { AsrProvider, VoiceProvider } from "../api/client-types-config";

export type PresetPlatform = "desktop" | "mobile" | "web";

/** Subset of the runtime-mode enum we care about for provider defaults. */
export type PresetRuntimeMode = "local" | "local-only" | "cloud" | "remote";

export interface PickDefaultVoiceProviderInput {
  platform: PresetPlatform;
  runtimeMode: PresetRuntimeMode;
}

export interface DefaultVoiceProviderResult {
  tts: VoiceProvider;
  asr: AsrProvider;
}

/**
 * Resolve the default {tts, asr} pair given the current platform and the
 * agent's runtime mode. The user can always override either pick in the
 * advanced settings.
 */
export function pickDefaultVoiceProvider(
  input: PickDefaultVoiceProviderInput,
): DefaultVoiceProviderResult {
  const { platform, runtimeMode } = input;

  // Cloud / remote: cloud everything, regardless of which device drives
  // the UI. The agent isn't on this machine; we always route audio to the
  // server's cloud-backed pipelines.
  if (runtimeMode === "cloud" || runtimeMode === "remote") {
    return { tts: "elevenlabs", asr: "eliza-cloud" };
  }

  // Local / local-only: split by platform. Desktop has the CPU/GPU budget
  // for OmniVoice + Qwen3-ASR. Mobile runs on-device Kokoro for TTS (small +
  // fast) but offloads the heavier ASR pipeline to Eliza Cloud. A web shell
  // hosting a local agent can't run on-device audio, so it stays on Cloud.
  if (platform === "desktop") {
    return { tts: "local-inference", asr: "local-inference" };
  }

  if (platform === "mobile") {
    return { tts: "local-inference", asr: "eliza-cloud" };
  }

  return { tts: "elevenlabs", asr: "eliza-cloud" };
}
