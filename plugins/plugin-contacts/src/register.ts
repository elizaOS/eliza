/**
 * Side-effect entry point — registers the Contacts app-shell page on elizaOS only.
 *
 * Stock Android, web, iOS, and desktop leave the apps catalog unchanged so the
 * same import is safe everywhere. Non-elizaOS callers will simply not see
 * Contacts in the app shell. Load this module once during app startup to
 * register the page.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { isElizaOS } from "@elizaos/ui/platform/init";
import { CONTACTS_VIEW_CAPABILITIES } from "./view-capabilities";

if (isElizaOS()) {
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
      capabilities: [],
    },
    capabilities: CONTACTS_VIEW_CAPABILITIES,
    interact: async (capability, params) => {
      const { interact } = await import(
        "./components/ContactsAppView.interact"
      );
      return interact(capability, params);
    },
    loader: () =>
      import("./components/ContactsPage.tsx").then((module) => ({
        default: module.ContactsPage,
      })),
  });
}
