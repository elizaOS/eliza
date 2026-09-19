/**
 * Decides whether the dev-smoke local lane may skip its real-model onboarding
 * test. The hosted lane (`ELIZA_DEV_SMOKE_OFFLINE=1` under CI) must fail when no
 * supported live provider credential is configured instead of reporting a
 * skipped pass; a local developer running the same lane without CI keeps the
 * optional skip.
 */

export type LiveProviderLaneVerdict =
  | { action: "run" }
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string };

export interface LiveProviderLaneInput {
  /** Whether a supported live-model credential is configured for this run. */
  providerConfigured: boolean;
  /** Whether this is the local/offline dev-smoke lane. */
  offlineLane: boolean;
  /** Whether this run is the required hosted lane (CI). */
  required: boolean;
}

export function resolveLiveProviderLaneVerdict(
  input: LiveProviderLaneInput,
): LiveProviderLaneVerdict {
  if (input.providerConfigured) return { action: "run" };
  if (input.offlineLane && input.required) {
    return {
      action: "fail",
      reason:
        "Required dev-smoke local lane has no supported live provider credential; refusing to pass without exercising a real assistant reply.",
    };
  }
  return {
    action: "skip",
    reason: "set a supported live provider key for dev smoke",
  };
}
