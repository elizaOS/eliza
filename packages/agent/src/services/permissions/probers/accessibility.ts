/**
 * Accessibility prober.
 *
 * Native APIs:
 *   - check:   AXIsProcessTrusted() (via libMacWindowEffects.dylib)
 *   - request: AXIsProcessTrustedWithOptions({ AXTrustedCheckOptionPrompt: true })
 *
 * On macOS this permission cannot be granted programmatically — the prompt
 * directs the user to System Settings, where they must toggle the app on
 * manually. After the user toggles, the running process must restart to
 * pick up the new state. We surface that by returning the post-prompt
 * status verbatim; callers should treat `denied` as "user must restart".
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

const ID = "accessibility" as const;

export const accessibilityProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const lib = await getNativeDylib();
    const granted = lib?.checkAccessibilityPermission() ?? false;
    if (granted) return buildState(ID, "granted", { canRequest: false });

    // Native check returned false — consult TCC.db to distinguish
    // "denied" (explicit user no) from "not-determined" (never asked).
    const tcc = await queryTccStatus(
      "kTCCServiceAccessibility",
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
    // AXIsProcessTrustedWithOptions with prompt:true opens the System
    // Settings panel and adds the app to the list. The user must still
    // toggle it on manually; the call returns the *current* state.
    lib?.requestAccessibilityPermission();
    const state = await accessibilityProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
