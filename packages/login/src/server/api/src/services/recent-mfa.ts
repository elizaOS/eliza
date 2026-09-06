/** Validate a privileged MFA step-up without accepting any future timestamp. */
export function isRecentMfaTimestamp(
  verifiedAt: unknown,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (
    typeof verifiedAt !== "number" ||
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    !Number.isFinite(nowMs)
  ) {
    return false;
  }
  const ageMs = nowMs - verifiedAt;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}
