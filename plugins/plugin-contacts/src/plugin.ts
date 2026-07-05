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
    // ONE declaration → GUI + XR + TUI, all drawn from the single ContactsView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build.
    {
      id: "contacts",
      label: "Contacts",
      description: "Android address book — read-only contact lookup",
      icon: "Users",
      path: "/contacts",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "ContactsView",
      tags: ["contacts", "android", "address-book"],
      visibleInManager: true,
      desktopTabEnabled: true,
      nativeOs: true,
    },
  ],
};

export { contactsProvider } from "./providers/contacts";
