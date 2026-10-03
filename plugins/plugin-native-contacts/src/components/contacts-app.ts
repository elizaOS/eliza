/**
 * Contacts App — @elizaos/plugin-native-contacts
 *
 * Full-screen overlay app that wraps the @elizaos/plugin-native-contacts/bridge native
 * plugin. Android-only; the platform gate in `../register.ts` decides whether
 * `registerContactsApp` is ever invoked.
 */

import { type OverlayApp } from "@elizaos/ui/apps/overlay-app-api";
import { registerOverlayApp } from "@elizaos/ui/apps/overlay-app-registry";
export const CONTACTS_APP_NAME = "@elizaos/plugin-native-contacts";
export const contactsApp: OverlayApp = {
  name: CONTACTS_APP_NAME,
  displayName: "Contacts",
  description: "Read and create entries in the Android address book",
  category: "system",
  icon: null,
  androidOnly: true,
  loader: () =>
    import("./ContactsAppView").then((m) => ({ default: m.ContactsAppView })),
};
/** Register the Contacts app with the overlay app registry. */
export function registerContactsApp(): void {
  registerOverlayApp(contactsApp);
}
