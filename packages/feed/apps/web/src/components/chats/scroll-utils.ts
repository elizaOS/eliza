export const SCROLL_TO_LATEST_THRESHOLD_PX = 180;

export function getDistanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function shouldShowScrollToLatest(
  distanceFromBottom: number,
  threshold = SCROLL_TO_LATEST_THRESHOLD_PX,
): boolean {
  return distanceFromBottom > threshold;
}
