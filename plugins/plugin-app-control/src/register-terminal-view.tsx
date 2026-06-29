/**
 * Register plugin-app-control's terminal views (views-manager, settings, voice).
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes each view's `viewType: "tui"` declaration render for real
 * in the terminal (the unified spatial view) rather than only navigating a GUI
 * shell. A module-level snapshot per view lets a host push live data; with no
 * host each renders its sensible empty/placeholder state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
	EMPTY_SETTINGS_SNAPSHOT,
	type SettingsSnapshot,
	SettingsSpatialView,
} from "./components/SettingsSpatialView.tsx";
import {
	type ViewManagerSnapshot,
	ViewManagerSpatialView,
} from "./components/ViewManagerSpatialView.tsx";
import {
	EMPTY_VOICE_SNAPSHOT,
	type VoiceSnapshot,
	VoiceSpatialView,
} from "./components/VoiceSpatialView.tsx";

const EMPTY: ViewManagerSnapshot = { views: [] };
let current: ViewManagerSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setViewManagerTerminalSnapshot(
	next: ViewManagerSnapshot,
): void {
	current = next;
}

/** Register the views-manager terminal view; returns an unregister function. */
export function registerViewManagerTerminalView(): () => void {
	return registerSpatialTerminalView("views-manager", () =>
		createElement(ViewManagerSpatialView, { snapshot: current }),
	);
}

let currentSettings: SettingsSnapshot = EMPTY_SETTINGS_SNAPSHOT;

/** Update the snapshot the registered settings terminal view renders from. */
export function setSettingsTerminalSnapshot(next: SettingsSnapshot): void {
	currentSettings = next;
}

/** Register the settings terminal view; returns an unregister function. */
export function registerSettingsTerminalView(): () => void {
	return registerSpatialTerminalView("settings", () =>
		createElement(SettingsSpatialView, { snapshot: currentSettings }),
	);
}

let currentVoice: VoiceSnapshot = EMPTY_VOICE_SNAPSHOT;

/** Update the snapshot the registered voice/transcript terminal view renders. */
export function setVoiceTerminalSnapshot(next: VoiceSnapshot): void {
	currentVoice = next;
}

/** Register the voice/transcription terminal view; returns an unregister function. */
export function registerVoiceTerminalView(): () => void {
	return registerSpatialTerminalView("voice", () =>
		createElement(VoiceSpatialView, { snapshot: currentVoice }),
	);
}
