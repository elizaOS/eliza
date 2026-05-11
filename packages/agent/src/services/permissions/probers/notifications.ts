/**
 * Notifications prober.
 *
 * Native APIs (macOS):
 *   - check:   UNUserNotificationCenter.current().getNotificationSettings { settings.authorizationStatus }
 *   - request: UNUserNotificationCenter.current().requestAuthorization(options:)
 *
 * UNUserNotificationCenter requires the running binary to be a properly
 * signed app bundle with `NSUserNotificationAlertStyle` in Info.plist. In
 * unsigned dev, the API may keep returning notDetermined. That is still
 * preferable to prompting during check().
 *
 * On win32/linux, concrete notification state is supplied by the renderer
 * fallback through Notification.permission.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapUNAuthStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "notifications" as const;

function stateFromNativeStatus(
  status: number | undefined,
  lastRequested?: number,
): PermissionState {
  const mapped = mapUNAuthStatus(status ?? 0);
  return buildState(ID, mapped, {
    canRequest: mapped === "not-determined",
    lastRequested,
    restrictedReason: mapped === "restricted" ? "os_policy" : undefined,
  });
}

export const notificationsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer fallback handles Notification.permission.
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lib = await getNativeDylib();
    if (!lib) return buildState(ID, "not-determined", { canRequest: true });
    return stateFromNativeStatus(lib.checkNotificationPermission());
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lastRequested = Date.now();
    const lib = await getNativeDylib();
    if (lib) {
      return stateFromNativeStatus(
        lib.requestNotificationPermission(),
        lastRequested,
      );
    }
    await runOsascript('display notification "" with title ""');
    return buildState(ID, "not-determined", { canRequest: true, lastRequested });
  },
};
