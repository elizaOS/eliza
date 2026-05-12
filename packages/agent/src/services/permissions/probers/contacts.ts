/**
 * Contacts prober.
 *
 * iMessage contact resolution and CRUD use CNContactStore, so the canonical
 * permission is the native Contacts privacy grant, not Automation.
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

const ID = "contacts" as const;
const TCC_SERVICE = "kTCCServiceAddressBook";

function stateFromNative(value: number): PermissionState {
  const status = mapNativePrivacyAuthStatus(value);
  return buildState(ID, status, {
    canRequest: status === "not-determined",
    restrictedReason: status === "restricted" ? "os_policy" : undefined,
  });
}

export const contactsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const lib = await getNativeDylib();
    if (lib) return stateFromNative(lib.checkContactsPermission());

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
      const state = stateFromNative(lib.requestContactsPermission());
      return { ...state, lastRequested: Date.now() };
    }

    await openPrivacyPane("Contacts");
    const state = await contactsProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
