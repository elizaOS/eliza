/**
 * Calendar prober.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapNativePrivacyAuthStatus,
  openPrivacyPane,
  platformUnsupportedState,
  queryTccStatus,
  resolveBundleId,
} from "./_bridge.js";

const ID = "calendar" as const;
const CALENDAR_TCC_SERVICE = "kTCCServiceCalendar";

function stateFromNative(value: number): PermissionState {
  const status = mapNativePrivacyAuthStatus(value);
  return buildState(ID, status, {
    canRequest: status === "not-determined" || value === 4,
    restrictedReason: status === "restricted" ? "os_policy" : undefined,
  });
}

export const calendarProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const native = await getNativeDylib();
    if (native) {
      return stateFromNative(native.checkCalendarPermission());
    }

    const tcc = await queryTccStatus(CALENDAR_TCC_SERVICE, resolveBundleId());
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const native = await getNativeDylib();
    if (native) {
      const state = stateFromNative(native.requestCalendarPermission());
      return { ...state, lastRequested: Date.now() };
    }
    await openPrivacyPane("Calendars");
    const state = await calendarProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
