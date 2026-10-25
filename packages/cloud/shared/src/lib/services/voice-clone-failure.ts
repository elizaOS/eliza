/** Defines the bounded failure vocabulary exposed by voice-clone API surfaces. */

export type VoiceCloneFailureReason =
  | "provider_submission_unknown"
  | "provider_work_reconciliation_required"
  | "provider_request_rejected"
  | "voice_clone_request_failed";

const failureReasons = new Set<VoiceCloneFailureReason>([
  "provider_submission_unknown",
  "provider_work_reconciliation_required",
  "provider_request_rejected",
  "voice_clone_request_failed",
]);

export function isVoiceCloneFailureReason(value: unknown): value is VoiceCloneFailureReason {
  return typeof value === "string" && failureReasons.has(value as VoiceCloneFailureReason);
}

export function exposedVoiceCloneFailureReason(
  value: unknown,
  reconciliationRequired: boolean,
): VoiceCloneFailureReason {
  if (isVoiceCloneFailureReason(value)) return value;
  return reconciliationRequired
    ? "provider_work_reconciliation_required"
    : "voice_clone_request_failed";
}
