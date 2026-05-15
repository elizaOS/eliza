/**
 * Health prober.
 *
 * Native APIs (macOS, iOS):
 *   - HKHealthStore.isHealthDataAvailable
 *   - HKHealthStore.authorizationStatus(for:)
 *
 * HealthKit on macOS requires the `com.apple.developer.healthkit`
 * entitlement signed into the app's provisioning profile. The Eliza dev
 * build is unsigned, so the entitlement isn't present and any HealthKit
 * call would crash or return `notDetermined` indefinitely.
 *
 * This prober detects the missing entitlement and reports
 * `restricted/entitlement_required` rather than attempting the call. When
 * the production build ships with the entitlement, swap in an FFI to
 * HKHealthStore.
 *
 * Sleep data lives behind this same permission (paired iPhone via
 * HealthKit). There's no separate `sleep` permission.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  hasEmbeddedProvisioningEntitlement,
  IS_DARWIN,
  platformUnsupportedState,
} from "./_bridge.js";

const ID = "health" as const;
const HEALTHKIT_ENTITLEMENT = "com.apple.developer.healthkit";

function hasHealthKitEntitlement(): boolean {
  return hasEmbeddedProvisioningEntitlement(HEALTHKIT_ENTITLEMENT);
}

export const healthProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    if (!hasHealthKitEntitlement()) {
      return buildState(ID, "restricted", {
        canRequest: false,
        restrictedReason: "entitlement_required",
      });
    }
    // TODO: when we ship a HealthKit FFI, call
    //   HKHealthStore.isHealthDataAvailable
    //   HKHealthStore.authorizationStatus(for: type)
    // and translate. For now we know we have the entitlement but no
    // way to query — surface as not-determined so the registry can
    // at least let callers request.
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    if (!hasHealthKitEntitlement()) {
      return buildState(ID, "restricted", {
        canRequest: false,
        restrictedReason: "entitlement_required",
        lastRequested: Date.now(),
      });
    }
    // Same TODO as check(). For now mirror the check result.
    return buildState(ID, "not-determined", {
      canRequest: true,
      lastRequested: Date.now(),
    });
  },
};
