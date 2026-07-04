/**
 * Smartglasses status formatting derives operator-facing setup summaries,
 * blocker reasons, and lens labels from service status.
 */
import type { SmartglassesStatus } from "./services/smartglasses-service.ts";
import type { SmartglassesConnectedLenses } from "./transport/types.ts";

export type SmartglassesPhysicalBlocker =
	| "disconnected"
	| "headset_not_found"
	| "partial_headset"
	| "in_charging_base"
	| "wearing_state_missing"
	| null;

export interface SmartglassesSetupSummary {
	setupHint: string | null;
	wholeHeadsetConnected: boolean;
	wearingReady: boolean;
	physicalBlocker: SmartglassesPhysicalBlocker;
}

export function formatConnectedLensesForAction(
	lenses: SmartglassesConnectedLenses,
): string {
	return `left=${formatLensForAction(lenses.left)}, right=${formatLensForAction(
		lenses.right,
	)}`;
}

export function formatConnectedLensesForProvider(
	lenses: SmartglassesConnectedLenses,
): string {
	return `left:${formatLensForProvider(lenses.left)} right:${formatLensForProvider(
		lenses.right,
	)}`;
}

export function setupSummaryForStatus(
	status: Pick<
		SmartglassesStatus,
		"connected" | "connectedLenses" | "physicalState" | "batteryState"
	>,
): SmartglassesSetupSummary {
	const wholeHeadsetConnected = Boolean(
		status.connected &&
			status.connectedLenses.left?.connected &&
			status.connectedLenses.right?.connected,
	);
	const anyLensConnected = Boolean(
		status.connectedLenses.left?.connected ||
			status.connectedLenses.right?.connected,
	);
	const wearingReady =
		wholeHeadsetConnected && status.physicalState === "wearing";
	if (!status.connected) {
		return {
			setupHint:
				"Connect the whole headset before display, tap, or microphone validation.",
			wholeHeadsetConnected,
			wearingReady,
			physicalBlocker: "disconnected",
		};
	}
	if (!anyLensConnected) {
		return {
			setupHint:
				"No G1 lenses were found. Remove both lenses from the charging base, keep them near this device, and rerun headset pairing.",
			wholeHeadsetConnected,
			wearingReady,
			physicalBlocker: "headset_not_found",
		};
	}
	if (!wholeHeadsetConnected) {
		return {
			setupHint:
				"Connect both left and right lenses before display, tap, or microphone validation.",
			wholeHeadsetConnected,
			wearingReady,
			physicalBlocker: "partial_headset",
		};
	}
	if (wearingReady) {
		return {
			setupHint: null,
			wholeHeadsetConnected,
			wearingReady,
			physicalBlocker: null,
		};
	}
	const stateText =
		[status.physicalState, status.batteryState].filter(Boolean).join(" / ") ||
		"no wearing state observed";
	if (isCradleOrChargingState(status.physicalState, status.batteryState)) {
		return {
			setupHint: `Glasses are reporting ${stateText}; remove them from the charging base and wear them before tap or microphone validation.`,
			wholeHeadsetConnected,
			wearingReady,
			physicalBlocker: "in_charging_base",
		};
	}
	return {
		setupHint: `Tap and microphone validation requires the glasses to report wearing; current state is ${stateText}.`,
		wholeHeadsetConnected,
		wearingReady,
		physicalBlocker: "wearing_state_missing",
	};
}

export function setupHintForStatus(
	status: Pick<
		SmartglassesStatus,
		"connected" | "connectedLenses" | "physicalState" | "batteryState"
	>,
): string | null {
	return setupSummaryForStatus(status).setupHint;
}

export function isCradleOrChargingState(
	physicalState: string | null,
	batteryState: string | null,
): boolean {
	return (
		physicalState === "cradle_open" ||
		physicalState === "cradle_closed" ||
		physicalState === "charged_in_cradle" ||
		batteryState === "glasses_fully_charged" ||
		batteryState === "cradle_charging_cable_changed" ||
		batteryState === "cradle_fully_charged"
	);
}

function formatLensForAction(
	lens: SmartglassesConnectedLenses[keyof SmartglassesConnectedLenses],
): string {
	if (!lens) return "missing";
	const state = lens.connected ? "connected" : "disconnected";
	return lens.name ? `${state} (${lens.name})` : state;
}

function formatLensForProvider(
	lens: SmartglassesConnectedLenses[keyof SmartglassesConnectedLenses],
): string {
	if (!lens) return "missing";
	return lens.connected ? "connected" : "disconnected";
}
