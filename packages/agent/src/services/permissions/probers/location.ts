/**
 * Location prober.
 *
 * Native APIs (macOS):
 *   - check:   CLLocationManager.authorizationStatus()
 *   - request: CLLocationManager.requestWhenInUseAuthorization()
 *
 * On win32/linux, concrete browser geolocation state is supplied by the
 * renderer fallback through navigator.permissions/geolocation.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapNativePrivacyAuthStatus,
  openPrivacyPane,
  queryTccStatus,
  resolveBundleId,
} from "./_bridge.js";

const ID = "location" as const;

function stateFromNative(value: number, lastRequested?: number): PermissionState {
  const status = mapNativePrivacyAuthStatus(value);
  return buildState(ID, status, {
    canRequest: status === "not-determined",
    lastRequested,
    restrictedReason: status === "restricted" ? "os_policy" : undefined,
  });
}

export const locationProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer fallback handles navigator.permissions/geolocation.
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const native = await getNativeDylib();
    if (native) {
      return stateFromNative(native.checkLocationPermission());
    }
    // CoreLocation on macOS uses a system-level daemon; the per-user
    // TCC.db won't always have a row. Treat null as not-determined.
    const tcc = await queryTccStatus("kTCCServiceLocation", resolveBundleId());
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lastRequested = Date.now();
    const native = await getNativeDylib();
    if (native) {
      return stateFromNative(native.requestLocationPermission(), lastRequested);
    }
    await openPrivacyPane("LocationServices");
    const state = await locationProber.check();
    return { ...state, lastRequested };
  },
};
