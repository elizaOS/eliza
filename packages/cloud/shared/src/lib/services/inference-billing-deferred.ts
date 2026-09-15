/**
 * Tier-3 deferred billing admission flag for the inference hot path (#9899).
 *
 * When enabled (`INFERENCE_DEFERRED_ADMISSION="true"`, default OFF) and the
 * request has a Workers `executionCtx`, organization inference admission
 * (`organization-inference-admission.ts`) may defer the durable admission
 * record off the critical path: the per-organization Durable Object lease is
 * the pre-provider write-ahead record and the post-response settlement replays
 * one deterministic debit identity.
 *
 * Refused or failed settlements invalidate the cross-isolate balance hint.
 * Worker dispatch remains fenced by the revision-aware Durable Object, so an
 * isolate-local refusal map must not create a second, stale admission authority.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";

type StringEnv = Record<string, string | undefined>;

/**
 * Tier-3 flag. Default OFF — same deliberate soak-then-cutover discipline as
 * `INFERENCE_OPTIMISTIC_BILLING` / `INFERENCE_BILLING_LEDGER`, which it extends
 * (it does nothing unless the optimistic path is enabled and eligible).
 */
export function isDeferredAdmissionEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_DEFERRED_ADMISSION ?? "").trim() === "true";
}
