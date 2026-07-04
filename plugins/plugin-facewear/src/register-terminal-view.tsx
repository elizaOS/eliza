/**
 * Register the facewear + smartglasses views for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes each view's `tui` modality render for real in the
 * terminal (the unified {@link FacewearSpatialView} / {@link
 * SmartglassesSpatialView}) rather than only navigating a GUI shell. A
 * module-level snapshot per view lets a host push live data; with nothing paired
 * each defaults to a sensible empty/disconnected state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
	EMPTY_FACEWEAR_SNAPSHOT,
	type FacewearSnapshot,
	FacewearSpatialView,
} from "./components/FacewearSpatialView.tsx";
import {
	type SmartglassesSnapshot,
	SmartglassesSpatialView,
} from "./components/SmartglassesSpatialView.tsx";
import type { HardwareReport } from "./ui/SmartglassesView.helpers.ts";

const EMPTY_REPORT: HardwareReport = {
	ok: false,
	generatedAt: "",
	transport: null,
	connected: false,
	lenses: { left: "idle", right: "idle" },
	scanDiagnosis: "not_scanned",
	physicalBlocker: "not_connected",
	setupHint:
		"Connect both left and right lenses as one headset before running validation.",
	nextAction: "Connect Headset",
	serialNumber: null,
	tests: {},
	missingEvidence: [],
	events: [],
	writes: [],
	audio: [],
	wifi: { available: false, status: "Not checked", networks: [] },
	headsetState: {
		physical: null,
		battery: null,
		batteryLevels: {},
		device: null,
	},
};

const EMPTY_SMARTGLASSES: SmartglassesSnapshot = {
	report: EMPTY_REPORT,
	micEnabled: false,
	wifiSsid: "",
	wifiPassword: "",
	testText: "Smartglasses display test.",
	activePlatform: "desktop",
	busy: null,
	error: null,
};

let currentFacewear: FacewearSnapshot = EMPTY_FACEWEAR_SNAPSHOT;
let currentSmartglasses: SmartglassesSnapshot = EMPTY_SMARTGLASSES;

/** Update the snapshot the registered facewear terminal view renders from. */
export function setFacewearTerminalSnapshot(next: FacewearSnapshot): void {
	currentFacewear = next;
}

/** Register the facewear terminal view; returns an unregister function. */
export function registerFacewearTerminalView(): () => void {
	return registerSpatialTerminalView("facewear", () =>
		createElement(FacewearSpatialView, { snapshot: currentFacewear }),
	);
}

/** Update the snapshot the registered smartglasses terminal view renders from. */
export function setSmartglassesTerminalSnapshot(
	next: SmartglassesSnapshot,
): void {
	currentSmartglasses = next;
}

/** Register the smartglasses terminal view; returns an unregister function. */
export function registerSmartglassesTerminalView(): () => void {
	return registerSpatialTerminalView("smartglasses", () =>
		createElement(SmartglassesSpatialView, { snapshot: currentSmartglasses }),
	);
}
