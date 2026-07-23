/**
 * Tier-3 deferred billing admission flag + refusal blocklist for the inference
 * hot path (#9899).
 *
 * When enabled (`INFERENCE_DEFERRED_ADMISSION="true"`, default OFF) and the
 * request has a Workers `executionCtx`, organization inference admission
 * (`organization-inference-admission.ts`) may defer the durable admission
 * record off the critical path: the per-organization Durable Object lease is
 * the pre-provider write-ahead record and the post-response settlement replays
 * one deterministic debit identity.
 *
 * The refusal blocklist re-exported here is the in-isolate half of the safety
 * envelope: an org whose deferred charge resolved refused (or whose fallback
 * debit failed) skips the deferred path for the TTL, so a broke org cannot
 * free-ride request-after-request inside the balance-hint window. The
 * cross-isolate bound is the org balance hint, invalidated on the same events.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import {
  clearAllOrgAdmissionRefusals,
  clearOrgAdmissionRefused,
  isOrgAdmissionRefused,
  markOrgAdmissionRefused,
} from "./inference-admission-refusal";

type StringEnv = Record<string, string | undefined>;

/**
 * Tier-3 flag. Default OFF — same deliberate soak-then-cutover discipline as
 * `INFERENCE_OPTIMISTIC_BILLING` / `INFERENCE_BILLING_LEDGER`, which it extends
 * (it does nothing unless the optimistic path is enabled and eligible).
 */
export function isDeferredAdmissionEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_DEFERRED_ADMISSION ?? "").trim() === "true";
}

export { clearOrgAdmissionRefused, isOrgAdmissionRefused, markOrgAdmissionRefused };

/** Test hook: reset the refusal blocklist between tests. */
export function __clearDeferredAdmissionState(): void {
  clearAllOrgAdmissionRefusals();
}
