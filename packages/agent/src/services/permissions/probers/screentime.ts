/**
 * Screen Time prober.
 *
 * Native APIs (macOS 12+):
 *   - STScreenTimeConfigurationObserver
 *   - AuthorizationCenter.shared.requestAuthorization(for: .individual)
 *
 * Screen Time is gated by the FamilyControls entitlement
 * (`com.apple.developer.family-controls`) which Apple grants only to
 * approved apps. The Eliza dev build doesn't have it, so we report
 * `restricted/entitlement_required`.
 *
 * The mobile-signals plugin already exposes a more elaborate Screen Time
 * status object on iOS — see
 * `eliza/plugins/plugin-native-mobile-signals/ios/.../ScreenTimeSupport.swift`.
 * On macOS we mirror its philosophy: detect the entitlement, refuse to
 * attempt the framework call without it.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  hasEmbeddedProvisioningEntitlement,
  IS_DARWIN,
  platformUnsupportedState,
} from "./_bridge.js";

const ID = "screentime" as const;
const FAMILY_CONTROLS_ENTITLEMENT = "com.apple.developer.family-controls";

function hasFamilyControlsEntitlement(): boolean {
  return hasEmbeddedProvisioningEntitlement(FAMILY_CONTROLS_ENTITLEMENT);
}

export const screentimeProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    if (!hasFamilyControlsEntitlement()) {
      return buildState(ID, "restricted", {
        canRequest: false,
        restrictedReason: "entitlement_required",
      });
    }
    // TODO: query STScreenTimeConfigurationObserver via FFI when we
    // ship the entitlement.
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    if (!hasFamilyControlsEntitlement()) {
      return buildState(ID, "restricted", {
        canRequest: false,
        restrictedReason: "entitlement_required",
        lastRequested: Date.now(),
      });
    }
    return buildState(ID, "not-determined", {
      canRequest: true,
      lastRequested: Date.now(),
    });
  },
};
