/**
 * Dispatch fallback policy — canonical home is the scheduling spine
 * (`@elizaos/plugin-scheduling`), which enforces it inside the runner's
 * fire path. Re-exported here so existing personal-assistant imports keep
 * working.
 */

export {
  type DispatchFailureReason,
  type DispatchPolicyContext,
  type DispatchPolicyDecision,
  decideDispatchPolicy,
} from "@elizaos/plugin-scheduling";
