/**
 * Reads historical welcome-credit withholding metadata from existing organizations.
 * New accounts start at zero and no longer write this legacy state.
 */

export type SignupGrantWithheldReason = "ip_daily_cap" | "count_unavailable";

export const WELCOME_BONUS_WITHHELD_SETTINGS_KEY = "welcomeBonusWithheld";

export interface WelcomeBonusWithheldRecord {
  reason: SignupGrantWithheldReason;
  message?: string;
}

const WITHHELD_REASONS: ReadonlySet<string> = new Set(["ip_daily_cap", "count_unavailable"]);

/**
 * Parses legacy metadata so old zero-balance organizations receive an accurate
 * explanation instead of being mistaken for newly created zero-balance accounts.
 */
export function readWelcomeBonusWithheldSettings(
  settings: unknown,
): WelcomeBonusWithheldRecord | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as Record<string, unknown>)[WELCOME_BONUS_WITHHELD_SETTINGS_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { reason, message } = raw as { reason?: unknown; message?: unknown };
  if (typeof reason !== "string" || !WITHHELD_REASONS.has(reason)) return null;
  return {
    reason: reason as SignupGrantWithheldReason,
    ...(typeof message === "string" && message.trim() ? { message } : {}),
  };
}
