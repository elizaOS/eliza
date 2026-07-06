/**
 * Cache-key resolution and flag gating for the Kokoro branch of the cloud TTS
 * route (#14375). The Kokoro path is the free web default; short whole-input
 * openers ("Got it.", "Sure.") otherwise pay full Railway synthesis every turn
 * because the ElevenLabs first-line cache sits after the Kokoro early return.
 *
 * This module owns the pure pieces the route composes: how a Kokoro request
 * maps onto the shared provider-keyed cache key (`provider: "kokoro"`, WAV
 * codec, deploy-tagged `voiceRevision`) and whether the caching is enabled at
 * all. It has no DB/R2/network dependency so the mapping and the flag gate are
 * unit-testable in isolation; the route wires these into the existing
 * `getCloudFirstLineCacheService` get/put paths.
 */

import { FIRST_SENTENCE_SNIP_VERSION } from "@elizaos/shared/voice/first-sentence-snip";
import type { CloudFirstLineCacheKey } from "@/lib/services/tts-first-line-cache";
import { fingerprintCloudVoiceSettings } from "@/lib/services/tts-first-line-cache";

/**
 * Kokoro synthesises 16-bit PCM WAV at 24 kHz. Both fields are part of the
 * cache key, so they must match the bytes the service actually returns — a
 * mismatch would let a differently-encoded entry masquerade as a hit.
 */
export const KOKORO_SAMPLE_RATE = 24000 as const;
export const KOKORO_CODEC = "wav" as const;

/**
 * The Kokoro voice is the free default and has no per-org custom clones, so
 * every entry lives in the shared `global` scope (same rule the ElevenLabs
 * default voices follow).
 */
export const KOKORO_CACHE_SCOPE = "global" as const;

/**
 * Deploy tag folded into `voiceRevision` when `KOKORO_SERVICE_IMAGE_TAG` is
 * unset. A stable literal (rather than a timestamp) keeps the cache warm across
 * restarts; a deployment that changes audio output must set the env var so the
 * revision — and therefore the key — rolls.
 */
const DEFAULT_KOKORO_IMAGE_TAG = "unpinned";

/**
 * Parse the `KOKORO_FIRST_LINE_CACHE` flag. Default off: the rollout is gated
 * on the #14370 TTFB benchmark, which needs the live Railway service to
 * measure, so caching stays disabled until an operator opts a deployment in.
 */
export function isKokoroFirstLineCacheEnabled(
  flag: string | undefined | null,
): boolean {
  if (!flag) return false;
  const v = flag.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Stable `voiceRevision` for a Kokoro voice. Includes the sample rate/codec so
 * a future output-format change is a distinct revision, and the deploy tag so a
 * service redeploy that alters audio invalidates only Kokoro entries.
 */
export function resolveKokoroVoiceRevision(
  kokoroVoice: string,
  imageTag: string | undefined | null,
): string {
  const tag = imageTag?.trim() || DEFAULT_KOKORO_IMAGE_TAG;
  return `kokoro:${kokoroVoice}:${KOKORO_SAMPLE_RATE}:${KOKORO_CODEC}:${tag}`;
}

/**
 * Build the shared cache key for a Kokoro opener. `normalizedText` is the
 * snip's normalised form; the caller guarantees it is a cacheable whole-input
 * opener before calling.
 */
export function buildKokoroCacheKey(args: {
  kokoroVoice: string;
  normalizedText: string;
  imageTag: string | undefined | null;
}): CloudFirstLineCacheKey {
  return {
    algoVersion: FIRST_SENTENCE_SNIP_VERSION,
    provider: "kokoro",
    voiceId: args.kokoroVoice,
    voiceRevision: resolveKokoroVoiceRevision(args.kokoroVoice, args.imageTag),
    sampleRate: KOKORO_SAMPLE_RATE,
    codec: KOKORO_CODEC,
    voiceSettingsFingerprint: fingerprintCloudVoiceSettings({
      // speed is pinned to 1 in the route; folding it in keeps the key honest
      // if that ever becomes a parameter.
      speed: 1,
    }),
    normalizedText: args.normalizedText,
    scope: KOKORO_CACHE_SCOPE,
  };
}
