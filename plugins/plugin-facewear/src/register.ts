import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import {
  FacewearTuiView,
  FacewearView,
  SmartglassesTuiView,
} from "./ui/FacewearView.tsx";
import { SmartglassesView } from "./ui/SmartglassesView.tsx";

registerAppShellPage({
  id: "hearwear",
  pluginId: "@elizaos/plugin-facewear",
  label: "Hearwear",
  icon: "Glasses",
  path: "/apps/hearwear",
  order: 80,
  group: "hardware",
  Component: FacewearView,
});

registerAppShellPage({
  id: "hearwear.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Hearwear TUI",
  icon: "Terminal",
  path: "/apps/hearwear/tui",
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

export {
  FacewearTuiView,
  FacewearView,
  SmartglassesTuiView,
} from "./ui/FacewearView.tsx";
export { SmartglassesView } from "./ui/SmartglassesView.tsx";
