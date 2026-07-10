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

import type { VoiceUsageLimits } from "../services/voice-usage-meter";

export interface VoiceRealtimeEnv {
  VOICE_REALTIME_WS_ENABLED?: string;
  VOICE_REALTIME_CARTESIA_VOICE_ID?: string;
  VOICE_REALTIME_ELIZA_ENDPOINT?: string;
  VOICE_REALTIME_ELIZA_AUTHORIZATION?: string;
  VOICE_REALTIME_ELIZA_MODEL?: string;
  VOICE_REALTIME_ORG_DAILY_MINUTES?: string;
  VOICE_REALTIME_USER_DAILY_MINUTES?: string;
  VOICE_REALTIME_MAX_SESSIONS?: string;
  CARTESIA_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
}

const TRUEY = new Set(["1", "true", "yes", "on"]);

const DEFAULT_ORG_DAILY_MINUTES = 600;
const DEFAULT_USER_DAILY_MINUTES = 120;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_ELIZA_MODEL = "gemma-4-31b";

/**
 * THE flag consumer. Returns true only when the operator has explicitly enabled
 * the realtime WS path. Every entrypoint gates on this.
 */
export function isVoiceRealtimeWsEnabled(env: VoiceRealtimeEnv | undefined): boolean {
  const raw = env?.VOICE_REALTIME_WS_ENABLED;
  if (typeof raw !== "string") return false;
  return TRUEY.has(raw.trim().toLowerCase());
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
