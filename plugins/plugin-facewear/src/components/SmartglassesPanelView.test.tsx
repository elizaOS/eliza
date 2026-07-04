/**
 * @vitest-environment jsdom
 *
 * SmartglassesPanelView tests cover the compact GUI/XR panel, live report
 * mirroring, local mic toggles, and native bridge Wi-Fi controls.
 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareReport } from "../ui/SmartglassesView.helpers.ts";
import { SmartglassesPanelView } from "./SmartglassesPanelView.tsx";

function makeReport(over: Partial<HardwareReport> = {}): HardwareReport {
	return {
		ok: false,
		generatedAt: "2026-06-18T00:00:00.000Z",
		transport: "native-bridge",
		connected: true,
		lenses: { left: "connected", right: "connected" },
		scanDiagnosis: "whole_headset_seen",
		physicalBlocker: null,
		setupHint: null,
		nextAction: null,
		serialNumber: "G1-AB12",
		tests: { init: true, display: false },
		missingEvidence: [],
		events: [],
		writes: [],
		audio: [],
		wifi: { available: true, status: "Connected to studio-net", networks: [] },
		headsetState: {
			physical: "wearing",
			battery: "discharging",
			batteryLevels: { left: 88, right: 84 },
			device: "Even G1",
		},
		...over,
	};
}

function button(agentId: string): HTMLButtonElement {
	const el = document.querySelector(`[data-agent-id="${agentId}"]`);
	if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
	return el as HTMLButtonElement;
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete window.facewearSmartglassesReport;
	delete window.__mentraBridge;
	delete window.__evenBridge;
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

describe("SmartglassesPanelView — unified GUI/XR panel", () => {
	it("mirrors the live report the dashboard publishes", () => {
		window.facewearSmartglassesReport = makeReport();
		render(<SmartglassesPanelView />);

		expect(screen.getByText(/sn G1-AB12/)).toBeTruthy();
		// The connected report drives the status caption + lens marks.
		expect(screen.getAllByText(/connected/i).length).toBeGreaterThan(0);
	});

	it("falls back to the disconnected default report when none is published", () => {
		render(<SmartglassesPanelView />);
		expect(screen.getByText("disconnected")).toBeTruthy();
	});

	it("toggles the mic state locally", () => {
		render(<SmartglassesPanelView />);
		expect(screen.getByText("Mic off")).toBeTruthy();
		fireEvent.click(button("mic-toggle"));
		expect(screen.getByText("Mic on")).toBeTruthy();
	});

	it("forwards a Wi-Fi scan to the native bridge and folds results into the report", async () => {
		const requestWifiScan = vi.fn(async () => ({
			networks: ["studio-net", "guest"],
		}));
		window.__mentraBridge = { requestWifiScan };
		render(<SmartglassesPanelView />);

		await act(async () => {
			fireEvent.click(button("wifi-scan"));
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(requestWifiScan).toHaveBeenCalledTimes(1);
		expect(screen.getByText("studio-net")).toBeTruthy();
	});

	it("surfaces an error when no native bridge is available for Wi-Fi actions", async () => {
		render(<SmartglassesPanelView />);
		await act(async () => {
			fireEvent.click(button("wifi-status"));
			await Promise.resolve();
		});
		expect(screen.getByText("Unavailable")).toBeTruthy();
	});
});
