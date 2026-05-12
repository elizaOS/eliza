import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsOwnerProfile } from "../owner-profile.js";
import { readLifeOpsOwnerProfile } from "../owner-profile.js";

/**
 * Reads the owner's configured morning/night check-in times from the existing
 * owner-profile row. Returns null for a slot if the owner hasn't configured it.
 *
 * `nightCheckinTime` is consumed by `shouldRunNightCheckinFromSleepCycle` as a
 * fallback bedtime anchor for irregular owners. `morningCheckinTime` is read
 * here for parity but the morning dispatcher currently relies exclusively on
 * the inferred `circadianState === "awake"` transition; an explicit timer
 * fallback is intentionally not wired.
 */

export interface CheckinSchedule {
  readonly morningCheckinTime: string | null;
  readonly nightCheckinTime: string | null;
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function normalizeTime(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = HHMM_RE.exec(trimmed);
  if (!match) return null;
  const [, rawHours = "", rawMinutes = ""] = match;
  const hours = Number.parseInt(rawHours, 10);
  const minutes = Number.parseInt(rawMinutes, 10);
  if (!Number.isFinite(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export async function resolveCheckinSchedule(
  runtime: IAgentRuntime,
): Promise<CheckinSchedule> {
  const profile: LifeOpsOwnerProfile = await readLifeOpsOwnerProfile(runtime);
  return {
    morningCheckinTime: normalizeTime(profile.morningCheckinTime),
    nightCheckinTime: normalizeTime(profile.nightCheckinTime),
  };
}
