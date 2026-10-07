/**
 * A pending field activated at unix epoch has a real time. `activatedAt || Date.now()`
 * told the agent the field had just been activated.
 */
export function recordedFieldActivatedAt(
  activatedAt: number | undefined,
  now: number,
): number {
  if (typeof activatedAt === "number" && Number.isFinite(activatedAt)) {
    return activatedAt;
  }
  return now;
}
