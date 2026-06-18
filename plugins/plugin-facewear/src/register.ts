import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import {
  FacewearTuiView,
  FacewearView,
  SmartglassesTuiView,
} from "./ui/FacewearView.tsx";
import { SmartglassesView } from "./ui/SmartglassesView.tsx";

registerAppShellPage({
  id: "facewear",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear",
  icon: "Glasses",
  path: "/apps/facewear",
  order: 80,
  group: "hardware",
  Component: FacewearView,
});

registerAppShellPage({
  id: "facewear.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear TUI",
  icon: "Terminal",
  path: "/apps/facewear/tui",
  order: 80.1,
  group: "hardware",
  Component: FacewearTuiView,
});

registerAppShellPage({
  id: "smartglasses",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 81,
  group: "hardware",
  Component: SmartglassesView,
});

registerAppShellPage({
  id: "smartglasses.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses TUI",
  icon: "Terminal",
  path: "/apps/smartglasses/tui",
  order: 81.1,
  group: "hardware",
  Component: SmartglassesTuiView,
});

// In a terminal host (the Node agent, no DOM), register the smartglasses view
// so it renders inline in the terminal as the unified SmartglassesSpatialView.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.tsx")
    .then((m) => m.registerSmartglassesTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

export {
  FacewearTuiView,
  FacewearView,
  SmartglassesTuiView,
} from "./ui/FacewearView.tsx";
export { SmartglassesView } from "./ui/SmartglassesView.tsx";
