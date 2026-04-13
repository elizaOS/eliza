/**
 * Companion App — @elizaos/app-companion
 *
 * Self-contained full-screen overlay app that renders a VRM avatar
 * with a chat dock. Implements the OverlayApp API so any similar
 * full-screen experience can follow the same pattern.
 *
 * Resources (VRM models, Three.js engine) load on mount and dispose
 * on unmount — nothing runs when the app is not active.
 */

import type { OverlayApp } from "@elizaos/app-core/components/apps/overlay-app-api";
import { registerOverlayApp } from "@elizaos/app-core/components/apps/overlay-app-registry";
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
