/**
 * Smartglasses status formatting tests pin setup hints and physical blocker
 * summaries shown to wearable users.
 */
import { describe, expect, it } from "vitest";
import { setupHintForStatus, setupSummaryForStatus } from "../status-format.ts";

describe("smartglasses status formatting", () => {
	it("guides disconnected users to connect the whole headset first", () => {
		const status = {
			connected: false,
			connectedLenses: {},
			physicalState: null,
			batteryState: null,
		};

		expect(setupHintForStatus(status)).toBe(
			"Connect the whole headset before display, tap, or microphone validation.",
		);
		expect(setupSummaryForStatus(status)).toMatchObject({
			wholeHeadsetConnected: false,
			wearingReady: false,
			physicalBlocker: "disconnected",
		});
	});

	it("flags partial lens evidence before wearing-state guidance", () => {
		expect(
			setupSummaryForStatus({
				connected: true,
				connectedLenses: {},
				physicalState: null,
				batteryState: null,
			}),
		).toMatchObject({
			setupHint:
				"No G1 lenses were found. Remove both lenses from the charging base, keep them near this device, and rerun headset pairing.",
			wholeHeadsetConnected: false,
			wearingReady: false,
			physicalBlocker: "headset_not_found",
		});

		expect(
			setupHintForStatus({
				connected: true,
				connectedLenses: {
					left: { connected: true },
				},
				physicalState: "wearing",
				batteryState: null,
			}),
		).toBe(
			"Connect both left and right lenses before display, tap, or microphone validation.",
		);
	});

	it("surfaces cradle blockers after whole-headset connection", () => {
		const status = {
			connected: true,
			connectedLenses: {
				left: { connected: true },
				right: { connected: true },
			},
			physicalState: "charged_in_cradle",
			batteryState: "cradle_fully_charged",
		};

		expect(setupHintForStatus(status)).toBe(
			"Glasses are reporting charged_in_cradle / cradle_fully_charged; remove them from the charging base and wear them before tap or microphone validation.",
		);
		expect(setupSummaryForStatus(status)).toMatchObject({
			wholeHeadsetConnected: true,
			wearingReady: false,
			physicalBlocker: "in_charging_base",
		});
	});
});
