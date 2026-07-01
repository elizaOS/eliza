import { registerSettingsSection } from "@elizaos/ui/components/settings/settings-section-registry";
import { Glasses } from "lucide-react";
import { WearablesSettingsSection } from "./components/WearablesSettingsSection.tsx";

// Wearable hardware (XR headsets + Even Realities smartglasses) is configuration,
// so it lives under Settings → Wearables instead of as two standalone launcher
// views. One settings section hosts both as tabs. The agent's XR/TUI view
// surfaces and FACEWEAR_*/SMARTGLASSES_*/XR_* actions are unaffected.
registerSettingsSection({
  id: "wearables",
  label: "settings.section.wearables",
  defaultLabel: "Wearables",
  icon: Glasses,
  tone: "neutral",
  hue: "slate",
  titleKey: "settings.section.wearables.title",
  defaultTitle: "Wearables",
  group: "system",
  order: 80,
  viewKind: "preview",
  Component: WearablesSettingsSection,
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
