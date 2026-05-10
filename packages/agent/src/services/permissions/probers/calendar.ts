/**
 * Calendar prober.
 *
 * Native APIs (macOS):
 *   - check:   EKEventStore.authorizationStatus(for: .event)
 *   - request: EKEventStore.requestFullAccessToEvents (macOS 14+) or
 *              .requestAccess(to: .event)
 *
 * Uses TCC.db reads (kTCCServiceCalendar) for check, AppleScript shellout
 * to Calendar.app for request. Same INTEGRATION TODO as reminders.ts.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryTccStatus,
  resolveBundleId,
  runOsascript,
} from "./_bridge.js";

const ID = "calendar" as const;

export const calendarProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryTccStatus("kTCCServiceCalendar", resolveBundleId());
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
