/**
 * Realtime voice-session runtime configuration + the `VOICE_REALTIME_WS_ENABLED`
 * flag consumer.
 *
 * The flag MUST have a real runtime consumer (a dead flag was exactly what
 * closed PR 16011): `isVoiceRealtimeWsEnabled()` is called by BOTH the
 * mint/revoke route and the WS handler. When the flag is unset or falsey the
 * route returns 404 and the WS refuses the upgrade, so the client falls back to
 * the existing batch path. Nothing about the realtime path activates until an
 * operator explicitly turns this on.
 */

import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../models/catalog";
import {
  FISH_AUDIO_MODEL_S1,
  FISH_AUDIO_MODEL_S2_PRO,
  FISH_AUDIO_MODEL_S21_PRO,
  FISH_AUDIO_MODEL_S21_PRO_FREE,
  type FishAudioModel,
} from "../services/fish-audio-tts";
import type { VoiceUsageLimits } from "../services/voice-usage-meter";

export interface VoiceRealtimeEnv {
  VOICE_REALTIME_WS_ENABLED?: string;
  VOICE_REALTIME_CARTESIA_VOICE_ID?: string;
  ELIZA_TTS_FISH_ENABLED?: string;
  FISH_AUDIO_DATA_GOVERNANCE_APPROVED?: string;
  FISH_AUDIO_API_KEY?: string;
  FISH_AUDIO_MODEL?: string;
  FISH_AUDIO_REFERENCE_ID?: string;
  FISH_AUDIO_VOICE_ID?: string;
  FISH_AUDIO_SAMPLE_RATE?: string;
  FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS?: string;
  VOICE_REALTIME_ELIZA_ENDPOINT?: string;
  VOICE_REALTIME_ELIZA_AUTHORIZATION?: string;
  VOICE_REALTIME_ELIZA_MODEL?: string;
  VOICE_REALTIME_ORG_DAILY_MINUTES?: string;
  VOICE_REALTIME_USER_DAILY_MINUTES?: string;
  VOICE_REALTIME_MAX_SESSIONS?: string;
  CARTESIA_API_KEY?: string;
}

const TRUEY = new Set(["1", "true", "yes", "on"]);

const DEFAULT_ORG_DAILY_MINUTES = 600;
const DEFAULT_USER_DAILY_MINUTES = 120;
const DEFAULT_MAX_SESSIONS = 200;
// The voice LLM leg rides the CLOUD DEFAULT small-model route (the same
// Cerebras-direct pin every fresh cloud agent gets via
// applyManagedAgentInferenceEnvDefaults), NOT a voice-local hardcode. Voice is
// the latency-critical consumer of that route: keeping this single-sourced
// means a cloud default-model change is exercised by staging voice
// automatically, and `VOICE_REALTIME_ELIZA_MODEL` stays a per-env override
// rather than a drift point.
const DEFAULT_ELIZA_MODEL = CEREBRAS_DEFAULT_TEXT_SMALL_MODEL;

/**
 * THE flag consumer. Returns true only when the operator has explicitly enabled
 * the realtime WS path. Every entrypoint gates on this.
 */
export function isVoiceRealtimeWsEnabled(env: VoiceRealtimeEnv | undefined): boolean {
  const raw = env?.VOICE_REALTIME_WS_ENABLED;
  if (typeof raw !== "string") return false;
  return TRUEY.has(raw.trim().toLowerCase());
}

/** Whether an operator requested Fish realtime TTS. */
export function isFishRealtimeTtsRequested(env: VoiceRealtimeEnv | undefined): boolean {
  const raw = env?.ELIZA_TTS_FISH_ENABLED;
  if (typeof raw !== "string") return false;
  return TRUEY.has(raw.trim().toLowerCase());
}

/** Server-only approval after the provider's retention/training policy is attested. */
export function isFishAudioDataGovernanceApproved(env: VoiceRealtimeEnv | undefined): boolean {
  const raw = env?.FISH_AUDIO_DATA_GOVERNANCE_APPROVED;
  if (typeof raw !== "string") return false;
  return TRUEY.has(raw.trim().toLowerCase());
}

/** Fish participates only when both enablement and governance approval are explicit. */
export function isFishRealtimeTtsEnabled(env: VoiceRealtimeEnv | undefined): boolean {
  return isFishRealtimeTtsRequested(env) && isFishAudioDataGovernanceApproved(env);
}

export function resolveFishRealtimeSampleRate(env: VoiceRealtimeEnv | undefined): number {
  const raw = env?.FISH_AUDIO_SAMPLE_RATE;
  if (typeof raw !== "string" || raw.trim() === "") return 16_000;
  return Number(raw.trim()) === 16_000 ? 16_000 : Number.NaN;
}

export function resolveFishRealtimeModel(
  env: VoiceRealtimeEnv | undefined,
): FishAudioModel | undefined {
  const raw = env?.FISH_AUDIO_MODEL;
  if (typeof raw !== "string" || raw.trim() === "") return FISH_AUDIO_MODEL_S21_PRO;
  const model = raw.trim();
  if (
    model === FISH_AUDIO_MODEL_S1 ||
    model === FISH_AUDIO_MODEL_S2_PRO ||
    model === FISH_AUDIO_MODEL_S21_PRO ||
    model === FISH_AUDIO_MODEL_S21_PRO_FREE
  ) {
    return model;
  }
  return undefined;
}

export function resolveFishRealtimeFirstAudioTimeoutMs(env: VoiceRealtimeEnv | undefined): number {
  return parsePositiveInt(env?.FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS, 1_500);
}

export function resolveVoiceUsageLimits(env: VoiceRealtimeEnv | undefined): VoiceUsageLimits {
  return {
    organizationDailyMinutes: parsePositiveInt(
      env?.VOICE_REALTIME_ORG_DAILY_MINUTES,
      DEFAULT_ORG_DAILY_MINUTES,
    ),
    userDailyMinutes: parsePositiveInt(
      env?.VOICE_REALTIME_USER_DAILY_MINUTES,
      DEFAULT_USER_DAILY_MINUTES,
    ),
  };
}

export function resolveMaxSessions(env: VoiceRealtimeEnv | undefined): number {
  return parsePositiveInt(env?.VOICE_REALTIME_MAX_SESSIONS, DEFAULT_MAX_SESSIONS);
}

export function resolveElizaModel(env: VoiceRealtimeEnv | undefined): string {
  const raw = env?.VOICE_REALTIME_ELIZA_MODEL;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_ELIZA_MODEL;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
