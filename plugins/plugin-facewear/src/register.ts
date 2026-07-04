/**
 * Facewear settings registration adds the wearables section to GUI hosts and
 * terminal view renderers to Node hosts.
 */
import { logger } from "@elizaos/core";
import { registerSettingsSection } from "@elizaos/ui/components/settings/settings-section-registry";
import { Glasses } from "lucide-react";
import { WearablesSettingsSection } from "./components/WearablesSettingsSection.tsx";

// Wearable hardware is configuration, so it lives under Settings -> Wearables.
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

// DOM-guarded dynamic imports keep terminal rendering out of browser bundles.
if (typeof window === "undefined") {
	void import("./register-terminal-view.tsx")
		.then((m) => {
			m.registerFacewearTerminalView();
			m.registerSmartglassesTerminalView();
		})
		.catch((err) => {
			// error-policy:J6 terminal rendering is best-effort and must never
			// block plugin load; log so a genuine import failure stays visible.
			logger.warn({ err }, "[facewear] terminal view registration failed");
		});
}
