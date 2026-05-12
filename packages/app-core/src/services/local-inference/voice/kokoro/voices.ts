/**
 * Kokoro-82M voice catalog.
 *
 * Re-exports the bundled `KOKORO_VOICE_PACKS` table from `voice-presets.ts`
 * under the canonical filename the integration spec calls out, and adds a few
 * search helpers used by the runtime-selection layer and the picker UI.
 *
 * Each voice pack ships as a small (~256 fp32 values × 4 bytes ≈ 1 KB) style
 * tensor under `<modelRoot>/voices/<file>`. Adding voices is cheap (download
 * a single .bin), and a hot ONNX session can swap voices per-utterance with
 * no re-init cost — the model is the same.
 *
 * Upstream registry: https://huggingface.co/hexgrad/Kokoro-82M/tree/main/voices
 */

import type { KokoroVoiceId, KokoroVoicePack } from "./types";
import {
  findKokoroVoice,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_VOICE_PACKS,
} from "./voice-presets";

export {
  findKokoroVoice,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_VOICE_PACKS,
} from "./voice-presets";

/** All voice ids that ship with the upstream Kokoro v1.0 release. */
export function listKokoroVoiceIds(): ReadonlyArray<KokoroVoiceId> {
  return KOKORO_VOICE_PACKS.map((v) => v.id);
}

/** Filter voice packs by language tag (`a` US, `b` UK, etc.). */
export function listKokoroVoicesByLang(
  lang: string,
): ReadonlyArray<KokoroVoicePack> {
  return KOKORO_VOICE_PACKS.filter((v) => v.lang === lang);
}

/** Filter by an exact tag (`female`, `male`, `british`, `breathy`, ...). */
export function listKokoroVoicesByTag(
  tag: string,
): ReadonlyArray<KokoroVoicePack> {
  return KOKORO_VOICE_PACKS.filter((v) => v.tags?.includes(tag) === true);
}

/**
 * Resolve a caller-supplied voice id against the registry. Returns the
 * matching pack, or the default pack when the id is not bundled. Never
 * throws — runtime selection treats this as a graceful fallback because the
 * caller's `SpeakerPreset.voiceId` may have been authored for OmniVoice.
 */
export function resolveKokoroVoiceOrDefault(id: string): KokoroVoicePack {
  const match = findKokoroVoice(id);
  if (match) return match;
  const fallback = findKokoroVoice(KOKORO_DEFAULT_VOICE_ID);
  if (!fallback) {
    throw new Error(
      `[kokoro] default voice id ${KOKORO_DEFAULT_VOICE_ID} is missing from KOKORO_VOICE_PACKS — registry is corrupted`,
    );
  }
  return fallback;
}
