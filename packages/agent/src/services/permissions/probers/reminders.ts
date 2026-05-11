/**
 * Reminders prober.
 *
 * LifeOps currently talks to Reminders.app through AppleScript, so the
 * effective permission is Apple Events from this runtime to Reminders.app.
 * We read that TCC row for check() and reserve osascript for request(),
 * where a prompt is expected.
 *
 * INTEGRATION TODO: ship a small Swift FFI that calls
 * `EKEventStore.authorizationStatus(for: .reminder)` directly if/when the
 * implementation moves from AppleScript to EventKit.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryAppleEventsTccStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "reminders" as const;
const REMINDERS_BUNDLE_ID = "com.apple.reminders";

export const remindersProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryAppleEventsTccStatus(REMINDERS_BUNDLE_ID);
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    // Trigger the OS prompt by issuing a benign read against Reminders.
    // `count of lists` is read-only; macOS will surface the consent
    // dialog the first time the runtime calls this.
    await runOsascript('tell application "Reminders" to count of lists');
    const state = await remindersProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
