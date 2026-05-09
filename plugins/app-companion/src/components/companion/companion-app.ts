import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { CompanionAppView } from "./CompanionAppView";

export const COMPANION_APP_NAME = "@elizaos/app-companion";

export const companionApp: OverlayApp = {
  name: COMPANION_APP_NAME,
  displayName: "Eliza Companion",
  description: "3D companion with VRM avatar and chat",
  category: "game",
  icon: null,
  Component: CompanionAppView,
};

/** Register the companion app with the overlay app registry. */
export function registerCompanionApp(): void {
  registerOverlayApp(companionApp);
}
