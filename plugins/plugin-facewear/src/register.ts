import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import type { ComponentType } from "react";

type DeferredViewComponent = ComponentType<Record<string, unknown>>;
type DeferredViewModule = { default: DeferredViewComponent };

function loadFacewearView(): Promise<DeferredViewModule> {
  return import("./components/FacewearView.tsx").then((module) => ({
    default: module.FacewearView as DeferredViewComponent,
  }));
}

function loadSmartglassesView(): Promise<DeferredViewModule> {
  return import("./ui/SmartglassesView.tsx").then((module) => ({
    default: module.SmartglassesView as DeferredViewComponent,
  }));
}

// Register the in-process app-shell pages so the views render on native (where
// the remote view bundle is disabled). Both load the single canonical surface:
// the FacewearView tri-modal wrapper renders FacewearSpatialView; the
// Smartglasses dashboard owns the BLE transport.
registerAppShellPage({
  id: "facewear",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear",
  icon: "Glasses",
  path: "/apps/facewear",
  order: 80,
  group: "hardware",
  loader: loadFacewearView,
});

registerAppShellPage({
  id: "smartglasses",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 81,
  group: "hardware",
  loader: loadSmartglassesView,
});

// In a terminal host (the Node agent, no DOM), register the facewear and
// smartglasses views so they render inline in the terminal as the unified
// FacewearSpatialView / SmartglassesSpatialView.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.tsx")
    .then((m) => {
      m.registerFacewearTerminalView();
      m.registerSmartglassesTerminalView();
    })
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
