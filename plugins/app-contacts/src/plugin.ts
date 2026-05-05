/**
 * elizaOS runtime plugin for the Contacts overlay app.
 *
 * Contacts are exposed as a dynamic provider, not a LIST_CONTACTS action:
 * reading the address book is read-only context for planning, while live
 * operations such as calling remain in the Phone app actions. The agent
 * Android adapter applies hosted-app session gating when this package's
 * `/plugin` export is registered.
 */

import type { Plugin } from "@elizaos/core";
import { contactsProvider } from "./providers/contacts";

const CONTACTS_APP_NAME = "@elizaos/app-contacts";

export const appContactsPlugin: Plugin = {
  name: CONTACTS_APP_NAME,
  description:
    "Contacts overlay: read-only Android address-book context via the @elizaos/capacitor-contacts native plugin. The Android runtime adapter gates the provider to the active Contacts app session.",
  providers: [contactsProvider],
};

export default appContactsPlugin;

export { contactsProvider } from "./providers/contacts";
