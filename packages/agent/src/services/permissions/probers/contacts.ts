/**
 * Contacts prober.
 *
 * Contacts integrations currently use Contacts.app through AppleScript.
 * The effective permission is therefore Apple Events from this runtime to
 * Contacts.app. check() reads that TCC row; request() runs the benign
 * AppleScript probe that can surface the OS prompt.
 *
 * INTEGRATION TODO: switch this to CNContactStore authorization checks if
 * the Contacts implementation moves away from AppleScript.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  platformUnsupportedState,
  queryAppleEventsTccStatus,
  runOsascript,
} from "./_bridge.js";

const ID = "contacts" as const;
const CONTACTS_BUNDLE_ID = "com.apple.AddressBook";

export const contactsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);

    const tcc = await queryAppleEventsTccStatus(CONTACTS_BUNDLE_ID);
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
