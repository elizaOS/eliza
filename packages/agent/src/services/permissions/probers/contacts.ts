/**
 * Contacts prober.
 *
 * iMessage contact resolution and CRUD use CNContactStore, so the canonical
 * permission is the native Contacts privacy grant, not Automation.
 */

import { createNativePrivacyProber } from "./_bridge.js";

export const contactsProber = createNativePrivacyProber({
  id: "contacts",
  service: "kTCCServiceAddressBook",
  pane: "Contacts",
  check: (native) => native.checkContactsPermission(),
  request: (native) => native.requestContactsPermission(),
  requestFullAccess: false,
});
