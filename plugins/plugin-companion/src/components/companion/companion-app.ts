import type { OverlayApp } from "@elizaos/ui/components/apps/overlay-app-api";
import { registerOverlayApp } from "@elizaos/ui/components/apps/overlay-app-registry";

export const COMPANION_APP_NAME = "@elizaos/plugin-companion";

export const companionApp: OverlayApp = {
  name: COMPANION_APP_NAME,
  displayName: "Eliza Companion",
  description: "3D companion with VRM avatar and chat",
  category: "game",
  icon: null,
  loader: () =>
    import("./CompanionAppView").then((m) => ({ default: m.CompanionAppView })),
};

/** Register the companion app with the overlay app registry. */
export function registerCompanionApp(): void {
  registerOverlayApp(companionApp);
}
