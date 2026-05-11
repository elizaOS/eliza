/**
 * Screen Time prober.
 *
 * Native APIs (macOS 12+):
 *   - STScreenTimeConfigurationObserver
 *   - AuthorizationCenter.shared.requestAuthorization(for: .individual)
 *
 * Screen Time is gated by the FamilyControls entitlement
 * (`com.apple.developer.family-controls`) which Apple grants only to
 * approved apps. The Milady dev build doesn't have it, so we report
 * `restricted/entitlement_required`.
 *
 * The mobile-signals plugin already exposes a more elaborate Screen Time
 * status object on iOS — see
 * `eliza/packages/native-plugins/mobile-signals/ios/.../ScreenTimeSupport.swift`.
 * On macOS we mirror its philosophy: detect the entitlement, refuse to
 * attempt the framework call without it.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PermissionState, Prober } from "../contracts.js";
import { buildState, IS_DARWIN, platformUnsupportedState } from "./_bridge.js";

const ID = "screentime" as const;

function hasFamilyControlsEntitlement(): boolean {
  try {
    const macOsDir = path.dirname(path.resolve(process.execPath));
    const contentsDir = path.resolve(macOsDir, "..");
    const embedded = path.join(contentsDir, "embedded.provisionprofile");
    if (!existsSync(embedded)) return false;
    const buf = readFileSync(embedded);
    return buf.includes(Buffer.from("com.apple.developer.family-controls"));
  } catch {
    return false;
  }
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
