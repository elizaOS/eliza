/**
 * Contacts prober.
 *
 * Native APIs (macOS):
 *   - check:   CNContactStore.authorizationStatus(for: .contacts)
 *   - request: CNContactStore.requestAccess(for: .contacts)
 *
 * Uses TCC.db reads (kTCCServiceAddressBook) for check, AppleScript
 * shellout to Contacts.app for request.
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

const ID = "contacts" as const;

export const contactsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryTccStatus(
      "kTCCServiceAddressBook",
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
    await runOsascript('tell application "Contacts" to count of people');
    const state = await contactsProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};
