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
 *     phones — see `selectVoiceBackend({ mobile: true })`). The ASR *provider*
 *     is Eliza Cloud (`eliza-cloud`) because on-device speech recognition is
 *     heavier than TTS — but see the layering note below: on native mobile the
 *     live capture engine is the OS recognizer, not this provider.
 *   - Cloud agents (any device) → free cloud Kokoro TTS
 *     (`eliza-cloud`) for speech, Eliza Cloud (`eliza-cloud`) for ASR.
 *     ElevenLabs is not a default (slow and key-gated); users can still opt
 *     into it from the advanced voice picker.
 *   - Remote-controller surfaces (UI hitting a remote API base) → same as
 *     cloud agents (`eliza-cloud` TTS, Eliza Cloud ASR).
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
 *
 * Layering caveat (this function is only one of two ASR layers): the `asr`
 * value it returns is the *provider* — the server-side transcription route the
 * settings picker seeds and the server uses when it transcribes. It does NOT
 * pick the interactive-capture engine. That is `resolveBackendKind` in
 * `voice-capture-factory.ts`, which on a native-mobile platform with the
 * TalkMode plugin present unconditionally uses the OS speech recognizer (the
 * only backend that streams interim transcripts, and the one whose assets are
 * actually staged on phones) ahead of any provider preference. So on native
 * mobile the `eliza-cloud` value below governs server-side transcription, not
 * the live on-device capture path — the two layers are chosen independently.
 *
 * On web/desktop the two layers now agree for `eliza-cloud`: the capture
 * factory records a WAV and POSTs it to the cloud STT proxy (`/api/asr/cloud`),
 * so interactive `eliza-cloud` ASR is the real cloud transcriber. Browser
 * SpeechRecognition is used only when WAV capture is unsupported (no
 * `getUserMedia`/`AudioContext`).
 *
 * `pickDefaultVoiceProvider` gives the platform/mode *preference*.
 * `resolveDefaultTtsProvider` (below) turns that preference into a concrete
 * provider against the runtime's actual capabilities — Kokoro on-device when
 * staged, else Kokoro via Eliza Cloud when a session exists, else ElevenLabs
 * (key-gated), else browser SpeechSynthesis — so a default is never pinned to a
 * backend that will fail on the first utterance.
 */

import type { AsrProvider, VoiceProvider } from "../api/client-types-config";

export type { VoiceProvider } from "../api/client-types-config";

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
  // on-device. Default to the measured free cloud Kokoro path for TTS and route
  // ASR to Eliza Cloud. The user can still opt into ElevenLabs or Edge in
  // advanced settings.
  if (runtimeMode === "cloud" || runtimeMode === "remote") {
    return { tts: "eliza-cloud", asr: "eliza-cloud" };
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
  // measured free cloud Kokoro path for TTS and Eliza Cloud for ASR.
  return { tts: "eliza-cloud", asr: "eliza-cloud" };
}

/**
 * Runtime capabilities observed at resolution time. `pickDefaultVoiceProvider`
 * expresses the *preferred* Kokoro path per platform/mode; this fills in whether
 * that path can actually run right now, so the default can fall through instead
 * of pinning a backend that will 503/401 on the first utterance.
 */
export interface VoiceCapabilitySnapshot {
  /** `GET /api/tts/local-inference/status` reported a staged on-device voice. */
  localInferenceTtsReady: boolean;
  /** A linked Eliza Cloud session with a working TTS proxy exists. */
  cloudVoiceAvailable: boolean;
  /** The user has configured an ElevenLabs API key. */
  elevenLabsKeyConfigured: boolean;
}

/**
 * The terminal browser-SpeechSynthesis fallback. `robot-voice` is not one of
 * the three server-backed engines the TTS queue dispatches (eliza-cloud /
 * local-inference / elevenlabs), so `useVoiceChat`'s processQueue routes it to
 * `speakBrowser` — i.e. it *is* the "speak with the OS voice" provider value.
 */
export const BROWSER_TTS_PROVIDER: VoiceProvider = "robot-voice";

/**
 * Resolve the concrete default TTS provider given the platform/mode preference
 * and what the runtime can actually do right now. This is the "no explicit user
 * choice" chain the product wants for bidirectional voice:
 *
 *   Kokoro on-device (`local-inference`, when its engine is staged)
 *     → Kokoro via Eliza Cloud (`eliza-cloud`, when a cloud session exists)
 *     → ElevenLabs (`elevenlabs`, only if a key is configured)
 *     → browser SpeechSynthesis ({@link BROWSER_TTS_PROVIDER}).
 *
 * The preferred entry point (from {@link pickDefaultVoiceProvider}) only orders
 * the two Kokoro transports for this platform — on desktop/mobile-local the
 * on-device path is tried first; on web/cloud the cloud path is. Whatever the
 * preference, an unavailable backend is skipped, never selected-then-failed.
 * ElevenLabs is deliberately last and key-gated: it is slow and never a silent
 * default. There is always a terminal answer (browser TTS), so this never
 * returns a provider that cannot run.
 *
 * Native mobile is not modeled here: `useVoiceChat` unconditionally routes the
 * reply through the native TalkMode engine (on-device Kokoro) on a Capacitor
 * platform, ahead of this web dispatch, so the on-device voice is used there
 * regardless of the resolved provider value.
 */
export function resolveDefaultTtsProvider(
  input: PickDefaultVoiceProviderInput,
  capabilities: VoiceCapabilitySnapshot,
): VoiceProvider {
  const preferred = pickDefaultVoiceProvider(input).tts;

  // On-device Kokoro first when the platform/mode preference chose it AND the
  // engine is actually staged. A desktop/mobile-local box whose voice bundle
  // isn't downloaded yet skips this and falls to the cloud path below.
  if (preferred === "local-inference" && capabilities.localInferenceTtsReady) {
    return "local-inference";
  }

  // Eliza Cloud Kokoro when a linked cloud session with a working TTS proxy
  // exists. This is the default on web/cloud, and the fallback when on-device
  // Kokoro isn't staged.
  if (capabilities.cloudVoiceAvailable) {
    return "eliza-cloud";
  }

  // On-device Kokoro is still preferable to ElevenLabs/browser even when the
  // platform preferred the cloud path but no cloud session is available — a
  // staged local voice beats a key-gated remote one.
  if (capabilities.localInferenceTtsReady) {
    return "local-inference";
  }

  // ElevenLabs only with a configured key. Never a silent default (slow + gated)
  // — reached only when no Kokoro transport is available.
  if (capabilities.elevenLabsKeyConfigured) {
    return "elevenlabs";
  }

  // Terminal: the OS SpeechSynthesis voice always exists in a browser renderer.
  return BROWSER_TTS_PROVIDER;
}
