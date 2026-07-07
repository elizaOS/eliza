/**
 * Facewear settings registration adds the wearables section to GUI hosts.
 */
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
