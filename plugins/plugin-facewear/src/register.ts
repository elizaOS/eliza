import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { FacewearView } from "./ui/FacewearView.tsx";
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
  id: "smartglasses",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 81,
  group: "hardware",
  Component: SmartglassesView,
});

export { FacewearView } from "./ui/FacewearView.tsx";
export { SmartglassesView } from "./ui/SmartglassesView.tsx";
