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

const CONTACTS_APP_NAME = "@elizaos/plugin-contacts";

export const appContactsPlugin: Plugin = {
  name: CONTACTS_APP_NAME,
  description:
    "Contacts overlay: read-only Android address-book context via the @elizaos/capacitor-contacts native plugin. The Android runtime adapter gates the provider to the active Contacts app session.",
  providers: [contactsProvider],
  views: [
    {
      id: "contacts",
      label: "Contacts",
      description: "Android address book — read-only contact lookup",
      icon: "Users",
      path: "/contacts",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ContactsAppView",
      tags: ["contacts", "android", "address-book"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "contacts",
      label: "Contacts XR",
      description: "Android address book — read-only contact lookup",
      icon: "Users",
      path: "/contacts",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ContactsAppView",
      tags: ["contacts", "android", "address-book"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "contacts",
      label: "Contacts TUI",
      description: "Terminal address-book lookup surface",
      icon: "Users",
      path: "/contacts/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ContactsTuiView",
      tags: ["contacts", "android", "address-book", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export { contactsProvider } from "./providers/contacts";
