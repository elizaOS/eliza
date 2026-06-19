/**
 * Screen Recording prober.
 *
 * Native APIs:
 *   - check:   CGPreflightScreenCaptureAccess()  (via libMacWindowEffects.dylib)
 *   - request: CGRequestScreenCaptureAccess()
 *
 * Like Accessibility, the OS doesn't grant this from a prompt — once
 * `CGRequestScreenCaptureAccess()` returns false the user must toggle the
 * app in System Settings → Privacy & Security → Screen Recording. After
 * toggling, the app must restart to pick up the new state.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  platformUnsupportedState,
  queryTccStatus,
  resolveBundleId,
} from "./_bridge.js";

const ID = "screen-recording" as const;

export const screenRecordingProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const lib = await getNativeDylib();
    const granted = lib?.checkScreenRecordingPermission() ?? false;
    if (granted) return buildState(ID, "granted", { canRequest: false });

    const tcc = await queryTccStatus(
      "kTCCServiceScreenCapture",
      resolveBundleId(),
    );
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const lib = await getNativeDylib();
    lib?.requestScreenRecordingPermission();
    const state = await screenRecordingProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
