/**
 * Classifies browser failures that the live development smoke intentionally
 * tolerates while optional runtime capabilities are unavailable.
 */

const LIFEOPS_ACTIVITY_SIGNALS_PATH = "/api/lifeops/activity-signals";
const RESOURCE_UNAVAILABLE_503 =
  /^Failed to load resource: the server responded with a status of 503 /i;

function hasPath(url: string, expectedPath: string): boolean {
  try {
    return new URL(url, "http://localhost").pathname === expectedPath;
  } catch {
    // error-policy:J3 Invalid browser URLs are never expected failures.
    return false;
  }
}

export function isExpectedDevSmokeResponse(
  status: number,
  url: string,
): boolean {
  return status === 503 && hasPath(url, LIFEOPS_ACTIVITY_SIGNALS_PATH);
}

export function isExpectedDevSmokeConsoleError(
  text: string,
  locationUrl: string,
): boolean {
  return (
    RESOURCE_UNAVAILABLE_503.test(text) &&
    hasPath(locationUrl, LIFEOPS_ACTIVITY_SIGNALS_PATH)
  );
}
