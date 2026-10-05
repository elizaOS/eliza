import { Capacitor } from "@capacitor/core";
import { registerAppShellPage } from "@elizaos/ui";
import { PHONE_VIEW_CAPABILITIES } from "./view-capabilities";
export function registerApp(): void {
  if (Capacitor.getPlatform() === "android") {
    registerAppShellPage({
      id: "phone",
      pluginId: "@elizaos/plugin-native-phone",
      label: "Phone",
      icon: "Phone",
      path: "/phone",
      tabAffinity: "phone",
      surface: {
        header: "fullscreen",
        capabilities: [],
      },
      capabilities: PHONE_VIEW_CAPABILITIES,
      interact: async (capability, params) => {
        const { interact } = await import("./components/phone-interact");
        return interact(capability, params);
      },
      loader: () =>
        import("./components/PhonePage.tsx").then((module) => ({
          default: module.PhonePage,
        })),
    });
  }

  registerAppShellPage({
    id: "phone-companion",
    pluginId: "@elizaos/plugin-native-phone",
    label: "Phone Companion",
    icon: "Smartphone",
    path: "/phone-companion",
    tabAffinity: "phone-companion",
    loader: () =>
      import("./companion/components/PhoneCompanionApp").then((module) => ({
        default: module.PhoneCompanionApp,
      })),
  });
}
