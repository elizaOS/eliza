import { isElizaOS, registerAppShellPage } from "@elizaos/ui";
import { CONTACTS_VIEW_CAPABILITIES } from "./view-capabilities";

export function registerApp(): void {
  if (isElizaOS()) {
    registerAppShellPage({
      id: "contacts",
      pluginId: "@elizaos/plugin-native-contacts",
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
}
