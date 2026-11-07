/**
 * Default voice + ASR provider selection.
 *
 * Captures the device+mode matrix the product team specified in the
 * settings "advanced mode" picker design:
 *
 *   - A device running a local agent (desktop, Android, AOSP) → on-device
 *     speech (TTS: `local-inference`, ASR: `local-inference`). Device ASR is
 *     Phonon-2 (Parakeet-TDT 0.6B, five-value weights) on libelizainference,
 *     the elizaOS llama.cpp fork; it is the only local ASR. Phones run
 *     Paradee-8M v1.1 for TTS on the same library.
 *   - Cloud agents (any device) → Eliza Cloud (`eliza-cloud`) for speech and
 *     for ASR (Cloud STT: Whisper / Cloudflare / ElevenLabs). ElevenLabs TTS is
 *     not a default (slow and key-gated); users can still opt into it from the
 *     advanced voice picker.
 *   - Web shells and remote-controller surfaces (UI hitting a remote API base)
 *     → same as cloud agents. ASR never runs locally in a browser or thin
 *     client; Eliza Cloud STT is their transcriber.
 *
 * The picker is intentionally a pure function so it can be unit-tested
 * exhaustively. The React hook wrapper lives in
 * `hooks/useDefaultProviderPresets.ts`.
 *
 * The ASR side of this matrix follows the device voice stack: ASR runs
 * locally only where the agent and libelizainference are on the device, and
 * everything else uses Eliza Cloud STT. When the local ASR is not staged yet,
 * {@link resolveWavAsrRoute} degrades a `local-inference` choice to the cloud
 * WAV route, so a device default never strands capture.
 *
 * Layering caveat (this function is only one of two ASR layers): the `asr`
 * value it returns is the *provider* — the server-side transcription route the
 * settings picker seeds and the server uses when it transcribes. It does NOT
 * pick the interactive-capture engine. That is `resolveBackendKind` in
 * `voice-capture-factory.ts`, which on a native-mobile platform with the
 * TalkMode plugin present unconditionally uses the OS speech recognizer (the
 * only backend that streams interim transcripts, and the one whose assets are
 * actually staged on phones) ahead of any provider preference. So on native
 * mobile the `asr` value below governs server-side transcription, not the
 * live capture path — the two layers are chosen independently.
 *
 * On web/desktop the two layers now agree for `eliza-cloud`: the capture
 * factory records a WAV and POSTs it to the cloud STT proxy (`/api/asr/cloud`),
 * so interactive `eliza-cloud` ASR is the real cloud transcriber. Browser
 * SpeechRecognition is used only when WAV capture is unsupported (no
 * `getUserMedia`/`AudioContext`).
 *
 * `pickDefaultVoiceProvider` gives the platform/mode *preference*.
 * `resolveDefaultTtsProvider` (below) turns that preference into a concrete
 * provider against the runtime's actual capabilities — Paradee on-device when
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

  // Local / local-only on a device (desktop, Android, AOSP): the agent and
  // libelizainference run here, so speech and Phonon-2 ASR stay on-device.
  // A web shell hosting a local agent has no on-device audio runtime, so it
  // stays on Eliza Cloud below.
  if (platform === "desktop" || platform === "mobile") {
    return { tts: "local-inference", asr: "local-inference" };
  }

  // Web shell hosting a local agent: no on-device audio runtime, so use the
  // measured free cloud Kokoro path for TTS and Eliza Cloud for ASR.
  return { tts: "eliza-cloud", asr: "eliza-cloud" };
}

/**
 * Runtime capabilities observed at resolution time. `pickDefaultVoiceProvider`
 * expresses the *preferred* speech path per platform/mode; this fills in whether
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
 * Cloud voice is usable only when the active session is authenticated and the
 * selected server config exposes its proxy. Neither signal is sufficient alone.
 */
export function isCloudVoiceRunnable(input: {
  connected: boolean;
  proxyAvailable: boolean;
}): boolean {
  return input.connected && input.proxyAvailable;
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
 *   Paradee v1.1 on-device (`local-inference`, when its engine is staged)
 *     → Kokoro via Eliza Cloud (`eliza-cloud`, when a cloud session exists)
 *     → ElevenLabs (`elevenlabs`, only if a key is configured)
 *     → browser SpeechSynthesis ({@link BROWSER_TTS_PROVIDER}).
 *
 * The preferred entry point (from {@link pickDefaultVoiceProvider}) only orders
 * the two speech transports for this platform — on desktop/mobile-local the
 * on-device path is tried first; on web/cloud the cloud path is. Whatever the
 * preference, an unavailable backend is skipped, never selected-then-failed.
 * ElevenLabs is deliberately last and key-gated: it is slow and never a silent
 * default. There is always a terminal answer (browser TTS), so this never
 * returns a provider that cannot run.
 *
 * Native mobile is not modeled here: `useVoiceChat` unconditionally routes the
 * reply through the native TalkMode engine (on-device Paradee) on a Capacitor
 * platform, ahead of this web dispatch, so the on-device voice is used there
 * regardless of the resolved provider value.
 */
export function resolveDefaultTtsProvider(
  input: PickDefaultVoiceProviderInput,
  capabilities: VoiceCapabilitySnapshot,
): VoiceProvider {
  const preferred = pickDefaultVoiceProvider(input).tts;

  // On-device Paradee first when the platform/mode preference chose it AND the
  // engine is actually staged. A desktop/mobile-local box whose voice bundle
  // isn't downloaded yet skips this and falls to the cloud path below.
  if (preferred === "local-inference" && capabilities.localInferenceTtsReady) {
    return "local-inference";
  }

  // Eliza Cloud Kokoro when a linked cloud session with a working TTS proxy
  // exists. This is the default on web/cloud, and the fallback when on-device
  // Paradee isn't staged.
  if (capabilities.cloudVoiceAvailable) {
    return "eliza-cloud";
  }

  // On-device Paradee is still preferable to ElevenLabs/browser even when the
  // platform preferred the cloud path but no cloud session is available — a
  // staged local voice beats a key-gated remote one.
  if (capabilities.localInferenceTtsReady) {
    return "local-inference";
  }

  // ElevenLabs only with a configured key. Never a silent default (slow + gated)
  // — reached only when no on-device or cloud speech transport is available.
  if (capabilities.elevenLabsKeyConfigured) {
    return "elevenlabs";
  }

  // Terminal: the OS SpeechSynthesis voice always exists in a browser renderer.
  return BROWSER_TTS_PROVIDER;
}

/** The two WAV-recording interactive ASR routes a capture surface can arm. */
export type WavAsrRoute = "local-inference" | "cloud";

/**
 * Resolve which WAV ASR route (if any) should serve an interactive capture,
 * given the effective provider and what the runtime can do right now. This is
 * the single fallback rule shared by BOTH capture surfaces — `useVoiceChat`'s
 * `startListening` and `voice-capture-factory`'s backend resolution — so the
 * two cannot diverge (#16524).
 *
 * The rule mirrors {@link resolveDefaultTtsProvider}'s contract: an
 * unavailable backend is skipped, never selected-then-failed. Concretely:
 *
 *   - Explicit `local-inference` stays local while the server reports ready.
 *   - `local-inference` selected but NOT ready degrades to the cloud WAV route
 *     (`/api/asr/cloud`) when a cloud session exists — a persisted desktop
 *     choice replayed against a cloud agent must not strand capture on the
 *     engine-dependent browser recognizer (absent on Safari/iOS PWA).
 *   - `eliza-cloud` / `openai` use the cloud WAV route, as before.
 *   - `null` means no WAV route applies (no capture primitives, `browser`
 *     forced, or an unready local choice with no cloud to fall back on) — the
 *     caller proceeds to its own talk-mode/browser cascade.
 */
export function resolveWavAsrRoute(input: {
  provider: AsrProvider | "browser" | undefined;
  cloudConnected: boolean;
  captureSupported: boolean;
  localInferenceReady: boolean;
}): WavAsrRoute | null {
  if (!input.captureSupported) return null;
  if (input.provider === "local-inference") {
    if (input.localInferenceReady) return "local-inference";
    return input.cloudConnected ? "cloud" : null;
  }
  if (input.provider === "eliza-cloud" || input.provider === "openai") {
    return "cloud";
  }
  return null;
}
