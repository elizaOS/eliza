/**
 * Classifies the current renderer window into the shell kind used to scope
 * renderer services (`@elizaos/ui/platform/renderer-services`). The app boots
 * one renderer per window — the primary dashboard plus special shells like
 * popouts, detached surface/settings windows, the phone companion, app
 * windows, and the /embed iframe — and background services
 * (e.g. LifeOps activity capture) must run only in the shells they declare,
 * not in every window that happens to import their registration module.
 *
 * The classification is a pure function of the boot inputs main.tsx already
 * resolves, so the precedence here (companion > popout > detached window
 * shells > app windows > embed > main) is unit-testable without
 * a browser boot.
 */
import type { RendererShellKind } from "@elizaos/ui/platform/renderer-services";
import type { WindowShellRoute } from "@elizaos/ui/platform/window-shell";

/** Stable app-shell view id used by the companion's dedicated renderer. */
export const PHONE_COMPANION_AGENT_VIEW_ID = "phone-companion";

export interface RendererShellScopeInputs {
  windowShellRoute: WindowShellRoute;
  isPopout: boolean;
  isPhoneCompanion: boolean;
  appWindowSlug: string | null;
  isEmbedRoute: boolean;
}

export function resolveRendererShellKind(
  inputs: RendererShellScopeInputs,
): RendererShellKind {
  if (inputs.isPhoneCompanion) return "phone-companion";
  if (inputs.isPopout) return "popout";
  switch (inputs.windowShellRoute.mode) {
    case "chat-overlay":
      return "chat-overlay";
    case "tray-popover":
      return "tray-popover";
    case "settings":
    case "surface":
      return "detached";
    case "main":
      break;
  }
  if (inputs.appWindowSlug !== null) return "app-window";
  if (inputs.isEmbedRoute) return "embed";
  return "main";
}
