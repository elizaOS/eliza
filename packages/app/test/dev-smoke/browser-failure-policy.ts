/**
 * Classifies browser failures that the live development smoke intentionally
 * tolerates while optional runtime capabilities are unavailable.
 */

const LIFEOPS_ACTIVITY_SIGNALS_PATH = "/api/lifeops/activity-signals";
const LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR =
  "LifeOps activity signals are unavailable because the personal-assistant runtime is not active";
const RESOURCE_UNAVAILABLE_503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

function hasPath(url: string, expectedPath: string): boolean {
  try {
    return new URL(url, "http://localhost").pathname === expectedPath;
  } catch {
    // error-policy:J3 Invalid browser URLs are never expected failures.
    return false;
  }
}

export function isLifeOpsActivitySignals503(
  status: number,
  url: string,
): boolean {
  return status === 503 && hasPath(url, LIFEOPS_ACTIVITY_SIGNALS_PATH);
}

export function isExpectedDevSmokeResponse(
  status: number,
  url: string,
  body: string,
): boolean {
  if (!isLifeOpsActivitySignals503(status, url)) return false;

  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.keys(parsed).length === 1 &&
      "error" in parsed &&
      parsed.error === LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR
    );
  } catch {
    // error-policy:J3 A malformed failure body is not the expected inactive signal.
    return false;
  }
}

export function isExpectedDevSmokeConsoleError(
  text: string,
  locationUrl: string,
): boolean {
  return (
    text === RESOURCE_UNAVAILABLE_503 &&
    hasPath(locationUrl, LIFEOPS_ACTIVITY_SIGNALS_PATH)
  );
}

export class ExpectedDevSmokeFailureMatcher {
  readonly #inactiveResponses = new Map<string, number>();

  recordResponse(status: number, url: string, body: string): boolean {
    if (!isExpectedDevSmokeResponse(status, url, body)) return false;
    this.#inactiveResponses.set(
      url,
      (this.#inactiveResponses.get(url) ?? 0) + 1,
    );
    return true;
  }

  consumeConsoleError(text: string, locationUrl: string): boolean {
    if (!isExpectedDevSmokeConsoleError(text, locationUrl)) return false;
    const remainingMatches = this.#inactiveResponses.get(locationUrl) ?? 0;
    if (remainingMatches === 0) return false;
    this.#inactiveResponses.set(locationUrl, remainingMatches - 1);
    return true;
  }
}
