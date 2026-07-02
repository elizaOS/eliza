/**
 * Dispatch fallback policy — canonical home is the scheduling spine
 * (`@elizaos/plugin-scheduling`), which enforces it inside the runner's
 * fire path. Re-exported here so existing personal-assistant imports keep
 * working.
 */

export {
  decideDispatchPolicy,
  type DispatchFailureReason,
  type DispatchPolicyContext,
  type DispatchPolicyDecision,
} from "@elizaos/plugin-scheduling";
