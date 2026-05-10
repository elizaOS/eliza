/**
 * Location prober.
 *
 * Native APIs (macOS):
 *   - check:   CLLocationManager.authorizationStatus()
 *   - request: CLLocationManager.requestAlwaysAuthorization()
 *
 * No FFI binding yet for CoreLocation. On dev (unsigned), CoreLocation
 * works but the prompt only fires from a foreground GUI session. We probe
 * via TCC.db (kTCCServiceLocation*) for check; for request we fall through
 * to an open of the privacy pane since there's no headless API path.
 *
 * INTEGRATION TODO: ship a CoreLocation FFI for proper
 * authorizationStatus() / requestWhenInUseAuthorization() support.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  openPrivacyPane,
  queryTccStatus,
  resolveBundleId,
} from "./_bridge.js";

const ID = "location" as const;

export const locationProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer falls back to navigator.permissions on win32/linux.
      return buildState(ID, "not-determined", { canRequest: true });
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
    // No headless way to trigger CoreLocation prompt in unsigned dev.
    // Best we can do: open the privacy pane.
    await openPrivacyPane("LocationServices");
    const state = await locationProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
