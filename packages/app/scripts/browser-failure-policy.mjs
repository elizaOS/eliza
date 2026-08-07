/**
 * Classifies the one optional-capability failure that browser-based app audits
 * may tolerate while the personal-assistant runtime is inactive. The response
 * contract is deliberately exact so unrelated 503s remain visible.
 */

export const LIFEOPS_ACTIVITY_SIGNALS_PATH = "/api/lifeops/activity-signals";
export const LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR =
  "LifeOps activity signals are unavailable because the personal-assistant runtime is not active";
const RESOURCE_UNAVAILABLE_503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

function hasPath(url, expectedPath) {
  try {
    return new URL(url, "http://localhost").pathname === expectedPath;
  } catch {
    // error-policy:J3 Invalid browser URLs are never expected failures.
    return false;
  }
}

export function isLifeOpsActivitySignals503(status, url) {
  return status === 503 && hasPath(url, LIFEOPS_ACTIVITY_SIGNALS_PATH);
}

export function isExpectedInactiveLifeOpsActivitySignalsResponse(
  status,
  url,
  body,
) {
  if (!isLifeOpsActivitySignals503(status, url) || typeof body !== "string") {
    return false;
  }

  try {
    const parsed = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed.error === LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR
    );
  } catch {
    // error-policy:J3 A malformed failure body is not the expected inactive signal.
    return false;
  }
}

export const isExpectedDevSmokeResponse =
  isExpectedInactiveLifeOpsActivitySignalsResponse;

export function isExpectedDevSmokeConsoleError(text, locationUrl) {
  return (
    text === RESOURCE_UNAVAILABLE_503 &&
    hasPath(locationUrl, LIFEOPS_ACTIVITY_SIGNALS_PATH)
  );
}

export class ExpectedDevSmokeFailureMatcher {
  #inactiveResponses = new Map();

  recordResponse(status, url, body) {
    if (!isExpectedDevSmokeResponse(status, url, body)) return false;
    this.#inactiveResponses.set(
      url,
      (this.#inactiveResponses.get(url) ?? 0) + 1,
    );
    return true;
  }

  consumeConsoleError(text, locationUrl) {
    if (!isExpectedDevSmokeConsoleError(text, locationUrl)) return false;
    const remainingMatches = this.#inactiveResponses.get(locationUrl) ?? 0;
    if (remainingMatches === 0) return false;
    this.#inactiveResponses.set(locationUrl, remainingMatches - 1);
    return true;
  }
}
