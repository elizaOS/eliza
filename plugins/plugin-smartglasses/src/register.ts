import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { SmartglassesView } from "./ui/SmartglassesView.js";

registerAppShellPage({
  id: "smartglasses",
  pluginId: "@elizaos/plugin-smartglasses",
  label: "Smartglasses",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 80,
  group: "hardware",
  Component: SmartglassesView,
});

export { SmartglassesView } from "./ui/SmartglassesView.js";
