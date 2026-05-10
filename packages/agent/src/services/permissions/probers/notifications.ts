/**
 * Notifications prober.
 *
 * Native APIs (macOS):
 *   - check:   UNUserNotificationCenter.current().getNotificationSettings { settings.authorizationStatus }
 *   - request: UNUserNotificationCenter.current().requestAuthorization(options:)
 *
 * UNUserNotificationCenter requires the running binary to be a properly
 * signed app bundle with `NSUserNotificationAlertStyle` in Info.plist. In
 * unsigned dev, the API silently returns notDetermined forever.
 *
 * No FFI binding yet — we shell out to `osascript -e 'display
 * notification ...'` as a no-op probe for `request`, and report
 * not-determined for `check` because we have no read-only path.
 *
 * INTEGRATION TODO: FFI to UNUserNotificationCenter, gated on whether the
 * runtime is launched from a signed app bundle.
 */

import type { PermissionState, Prober } from "../contracts.js";
import { buildState, IS_DARWIN, runOsascript } from "./_bridge.js";

const ID = "notifications" as const;

export const notificationsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer falls back to Notification.permission.
      return buildState(ID, "not-determined", { canRequest: true });
    }
    // No read-only path without UNUserNotificationCenter. Defer.
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    // Issue a benign notification to surface the consent dialog.
    // Whether macOS actually prompts depends on the bundle being
    // signed; in dev this is a silent no-op.
    await runOsascript('display notification "" with title ""');
    return buildState(ID, "not-determined", {
      canRequest: true,
      lastRequested: Date.now(),
    });
  },
};
