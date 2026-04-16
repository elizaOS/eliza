import { registerOverlayApp, type OverlayApp } from "@elizaos/app-core";
import { CompanionAppView } from "./CompanionAppView";

export const COMPANION_APP_NAME = "@elizaos/app-companion";

export const companionApp: OverlayApp = {
  name: COMPANION_APP_NAME,
  displayName: "Companion",
  description: "3D companion with VRM avatar and chat",
  category: "world",
  icon: null,
  Component: CompanionAppView,
};

/** Register the companion app with the overlay app registry. */
export function registerCompanionApp(): void {
  registerOverlayApp(companionApp);
}
