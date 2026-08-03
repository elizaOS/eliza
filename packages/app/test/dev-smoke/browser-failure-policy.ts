/** Re-exports the browser-audit failure policy from its Node-compatible source. */

export {
  ExpectedDevSmokeFailureMatcher,
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
  isExpectedInactiveLifeOpsActivitySignalsResponse,
  isLifeOpsActivitySignals503,
} from "../../scripts/browser-failure-policy.mjs";
