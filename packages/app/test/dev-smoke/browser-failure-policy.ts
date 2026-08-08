/** Re-exports the browser-audit failure policy from its Node-compatible source. */

export {
  BROWSER_BRIDGE_COMPANIONS_PATH,
  BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR,
  browserResourceConsoleErrorStatus,
  ExpectedBrowserResponseConsoleMatcher,
  ExpectedDevSmokeFailureMatcher,
  isBrowserBridgeCompanions503,
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
  isExpectedDevSmokeResponseCandidate,
  isExpectedEmbeddedBrowserConsoleError,
  isExpectedInactiveLifeOpsActivitySignalsResponse,
  isExpectedUnavailableBrowserBridgeCompanionsResponse,
  isLifeOpsActivitySignals503,
} from "../../scripts/browser-failure-policy.mjs";
