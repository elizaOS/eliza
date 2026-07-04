/**
 * Default voice + ASR provider selection.
 *
 * Captures the device+mode matrix the product team specified in the
 * settings "advanced mode" picker design:
 *
 *   - Desktop running a local agent → on-device models
 *     (TTS: `local-inference` / OmniVoice, ASR: `local-inference` / Gemma ASR).
 *   - Mobile running a local agent → on-device Kokoro TTS
 *     (TTS: `local-inference`; Kokoro is ~82M params and runs comfortably on
 *     phones — see `selectVoiceBackend({ mobile: true })`). ASR still routes
 *     to Eliza Cloud (`eliza-cloud`) because on-device speech recognition is
 *     heavier than TTS.
 *   - Cloud agents (any device) → fast free Microsoft Edge neural TTS
 *     (`edge`) for speech, Eliza Cloud (`eliza-cloud`) for ASR. ElevenLabs is
 *     not a default (slow and key-gated); users can still opt into it from the
 *     advanced voice picker.
 *   - Remote-controller surfaces (UI hitting a remote API base) → same as
 *     cloud agents (`edge` TTS, Eliza Cloud ASR).
 *
 * The picker is intentionally a pure function so it can be unit-tested
 * exhaustively. The React hook wrapper lives in
 * `hooks/useDefaultProviderPresets.ts`.
 *
 * The ASR side of this matrix is not just a platform guess — it is backed by
 * the measured WER/latency/RTF decision record in `STT_SELECTION.md` (next to
 * this file; #11337): fused eliza-1-asr measured at WER 0.008 / 3.8× realtime
 * on desktop CPU (hence `local-inference` on desktop), while mobile/web stay
 * on `eliza-cloud` until on-device Stage-B numbers justify a flip.
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

  // Cloud / remote: the agent isn't on this machine, so speech can't run
  // on-device. Default to the fast, free Microsoft Edge neural voices
  // (`edge`) rather than the slow, key-gated ElevenLabs path, and route ASR
  // to Eliza Cloud. The user can still opt back into ElevenLabs in advanced
  // settings.
  if (runtimeMode === "cloud" || runtimeMode === "remote") {
    return { tts: "edge", asr: "eliza-cloud" };
  }

  // Local / local-only: split by platform. Desktop has the CPU/GPU budget
  // for OmniVoice + Gemma ASR. Mobile runs on-device Kokoro for TTS (small +
  // fast) but offloads the heavier ASR pipeline to Eliza Cloud. A web shell
  // hosting a local agent can't run on-device audio, so it stays on Cloud.
  if (platform === "desktop") {
    return { tts: "local-inference", asr: "local-inference" };
  }

  if (platform === "mobile") {
    return { tts: "local-inference", asr: "eliza-cloud" };
  }

  // Web shell hosting a local agent: no on-device audio runtime, so use the
  // fast free Edge neural voices for TTS and Eliza Cloud for ASR.
  return { tts: "edge", asr: "eliza-cloud" };
}
