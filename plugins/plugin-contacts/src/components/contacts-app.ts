/**
 * Contacts App — @elizaos/app-contacts
 *
 * Full-screen overlay app that wraps the @elizaos/capacitor-contacts native
 * plugin. Android-only; the platform gate in `../register.ts` decides whether
 * `registerContactsApp` is ever invoked.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { ContactsAppView } from "./ContactsAppView";

export const CONTACTS_APP_NAME = "@elizaos/app-contacts";

export const contactsApp: OverlayApp = {
  name: CONTACTS_APP_NAME,
  displayName: "Contacts",
  description: "Read and create entries in the Android address book",
  category: "system",
  icon: null,
  androidOnly: true,
  Component: ContactsAppView,
};

/** Register the Contacts app with the overlay app registry. */
export function registerContactsApp(): void {
  registerOverlayApp(contactsApp);
}
