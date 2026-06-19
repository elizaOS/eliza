/**
 * Reminders prober.
 *
 * LifeOps creates/updates/deletes Apple Reminders through EventKit, so the
 * canonical permission is the native Reminders privacy grant, not Automation.
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

const ID = "reminders" as const;
const TCC_SERVICE = "kTCCServiceReminders";

function stateFromNative(value: number): PermissionState {
  const status = mapNativePrivacyAuthStatus(value);
  return buildState(ID, status, {
    canRequest: status === "not-determined" || value === 4,
    restrictedReason: status === "restricted" ? "os_policy" : undefined,
  });
}

export const remindersProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const lib = await getNativeDylib();
    if (lib) return stateFromNative(lib.checkRemindersPermission());

    const tcc = await queryTccStatus(TCC_SERVICE, resolveBundleId());
    if (tcc === "granted")
      return buildState(ID, "granted", { canRequest: false });
    if (tcc === "denied")
      return buildState(ID, "denied", { canRequest: false });
    return buildState(ID, "not-determined", { canRequest: true });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const lib = await getNativeDylib();
    if (lib) {
      const state = stateFromNative(lib.requestRemindersPermission());
      return { ...state, lastRequested: Date.now() };
    }

    await openPrivacyPane("Reminders");
    const state = await remindersProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
