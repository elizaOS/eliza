/**
 * Calendar prober.
 *
 * Calendar.app integration is AppleScript-backed, so check() reads the
 * Apple Events TCC row for this runtime → Calendar.app. The osascript call
 * is only used in request(), where prompting is expected.
 *
 * INTEGRATION TODO: switch this to EventKit authorization checks if a
 * Calendar connector starts using EventKit instead of AppleScript.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryAppleEventsTccStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "calendar" as const;
const CALENDAR_BUNDLE_ID = "com.apple.iCal";

export const calendarProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryAppleEventsTccStatus(CALENDAR_BUNDLE_ID);
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    await runOsascript('tell application "Calendar" to count of calendars');
    const state = await calendarProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
