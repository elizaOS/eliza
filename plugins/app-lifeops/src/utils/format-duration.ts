// Humanize a raw minute count as `Xh Ym` / `Xh` / `Xm`. Returns a bare
// duration with no "in"/"ago" prefix so callers can wrap it in their own
// phrasing. Paired with formatRelativeMinutes in lifeops/google/format-helpers,
// which prefixes "in" for future-tense phrasing.
export function formatMinutesDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) {
    return `${total}m`;
  }
  const hours = Math.floor(total / 60);
  const remainingMinutes = total % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}
