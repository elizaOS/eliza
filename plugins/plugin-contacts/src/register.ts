/**
 * Side-effect entry point — registers the Contacts overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop leave the apps catalog unchanged so the
 * same import is safe everywhere. Non-ElizaOS callers will simply not see
 * Contacts in the apps catalog. Load this module once during app startup to
 * register the app.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { isElizaOS } from "@elizaos/ui/platform/init";
import { registerContactsApp } from "./components/contacts-app";

if (isElizaOS()) {
  registerContactsApp();
  registerAppShellPage({
    id: "contacts",
    pluginId: "@elizaos/plugin-contacts",
    label: "Contacts",
    icon: "ContactRound",
    path: "/contacts",
    tabAffinity: "contacts",
    order: 901,
    viewKind: "release",
    surface: {
      header: "fullscreen",
      capabilities: ["agent-surface"],
    },
    loader: () =>
      import("./components/ContactsPage.tsx").then((module) => ({
        default: module.ContactsPage,
      })),
  });
}
