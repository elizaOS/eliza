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
    // One shipped GUI declaration drawn from ContactsView. The modality enum is
    // retained in the contract for future alternate view entries.
    {
      id: "contacts",
      label: "Contacts",
      description: "Android address book — read-only contact lookup",
      icon: "Users",
      path: "/contacts",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "ContactsView",
      tags: ["contacts", "android", "address-book"],
      responseContext: { primaryContext: "contacts" },
      visibleInManager: true,
      desktopTabEnabled: true,
      nativeOs: true,
    },
  ],
};

export { contactsProvider } from "./providers/contacts";
