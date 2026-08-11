/**
 * Classifies exact optional-capability failures that browser-based app audits
 * may tolerate while their backing services are inactive. Response contracts
 * stay deliberately narrow so unrelated 503s remain visible.
 */

export const LIFEOPS_ACTIVITY_SIGNALS_PATH = "/api/lifeops/activity-signals";
export const LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR =
  "LifeOps activity signals are unavailable because the personal-assistant runtime is not active";
export const BROWSER_BRIDGE_COMPANIONS_PATH = "/api/browser-bridge/companions";
export const BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR =
  "Browser Bridge service is not available";
const RESOURCE_UNAVAILABLE_503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
const RESOURCE_ERROR_PATTERN =
  /^Failed to load resource: the server responded with a status of (\d{3}) \(.+\)$/;
const EMBEDDED_GOOGLE_AUTOFOCUS_ERROR =
  "Blocked autofocusing on a <textarea> element in a cross-origin subframe.";

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

export function isBrowserBridgeCompanions503(status, url) {
  return status === 503 && hasPath(url, BROWSER_BRIDGE_COMPANIONS_PATH);
}

export function isExpectedDevSmokeResponseCandidate(status, url) {
  return (
    isLifeOpsActivitySignals503(status, url) ||
    isBrowserBridgeCompanions503(status, url)
  );
}

function hasExactErrorBody(body, expectedError) {
  if (typeof body !== "string") return false;

  try {
    const parsed = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed.error === expectedError
    );
  } catch {
    // error-policy:J3 A malformed failure body is never an expected response.
    return false;
  }
}

export function isExpectedInactiveLifeOpsActivitySignalsResponse(
  status,
  url,
  body,
) {
  return (
    isLifeOpsActivitySignals503(status, url) &&
    hasExactErrorBody(body, LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR)
  );
}

export function isExpectedUnavailableBrowserBridgeCompanionsResponse(
  status,
  url,
  body,
) {
  return (
    isBrowserBridgeCompanions503(status, url) &&
    hasExactErrorBody(body, BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR)
  );
}

export function isExpectedDevSmokeResponse(status, url, body) {
  return (
    isExpectedInactiveLifeOpsActivitySignalsResponse(status, url, body) ||
    isExpectedUnavailableBrowserBridgeCompanionsResponse(status, url, body)
  );
}

export function isExpectedDevSmokeConsoleError(text, locationUrl) {
  return (
    text === RESOURCE_UNAVAILABLE_503 &&
    (hasPath(locationUrl, LIFEOPS_ACTIVITY_SIGNALS_PATH) ||
      hasPath(locationUrl, BROWSER_BRIDGE_COMPANIONS_PATH))
  );
}

export function browserResourceConsoleErrorStatus(text) {
  if (typeof text !== "string") return null;
  const match = RESOURCE_ERROR_PATTERN.exec(text);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

export function isExpectedEmbeddedBrowserConsoleError(text, locationUrl) {
  if (text !== EMBEDDED_GOOGLE_AUTOFOCUS_ERROR) return false;
  try {
    const url = new URL(locationUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.google.com" &&
      url.pathname === "/webhp" &&
      url.searchParams.get("igu") === "1"
    );
  } catch {
    // error-policy:J3 malformed console locations never enter the allowlist.
    return false;
  }
}

/** Correlates browser console resource errors with pre-classified responses. */
export class ExpectedBrowserResponseConsoleMatcher {
  #expectedResponses = new Map();

  recordResponse(status, url) {
    if (!Number.isInteger(status) || status < 400 || typeof url !== "string") {
      return false;
    }
    const key = `${status}\0${url}`;
    this.#expectedResponses.set(
      key,
      (this.#expectedResponses.get(key) ?? 0) + 1,
    );
    return true;
  }

  consumeConsoleError(text, locationUrl) {
    const status = browserResourceConsoleErrorStatus(text);
    if (status === null) return false;
    const key = `${status}\0${locationUrl}`;
    const remainingMatches = this.#expectedResponses.get(key) ?? 0;
    if (remainingMatches === 0) return false;
    this.#expectedResponses.set(key, remainingMatches - 1);
    return true;
  }
}

export class ExpectedDevSmokeFailureMatcher {
  #consoleMatcher = new ExpectedBrowserResponseConsoleMatcher();

  recordResponse(status, url, body) {
    if (!isExpectedDevSmokeResponse(status, url, body)) return false;
    return this.#consoleMatcher.recordResponse(status, url);
  }

  consumeConsoleError(text, locationUrl) {
    if (!isExpectedDevSmokeConsoleError(text, locationUrl)) return false;
    return this.#consoleMatcher.consumeConsoleError(text, locationUrl);
  }
}
