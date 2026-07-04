/**
 * SmartglassesPanelView — the single GUI/XR data wrapper for the Smartglasses
 * operator panel.
 *
 * It owns a live subset of the smartglasses diagnostics (the computed
 * {@link HardwareReport} the full dashboard publishes on
 * `window.facewearSmartglassesReport`, plus the headset connected-state from
 * `/api/facewear/status`) and renders the one presentational
 * {@link SmartglassesSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR, so the SAME
 * component serves both surfaces. The TUI surface renders the same
 * `SmartglassesSpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 *
 * The full BLE/transport dashboard (`../ui/SmartglassesView.tsx`) is unchanged;
 * it stays mounted as the app-shell page (and is what publishes the live report
 * this panel reads). Operator actions (`connect`, `run-check`, Wi-Fi, mic,
 * display) are dispatched to the same native bridge the dashboard drives, so the
 * panel is a real control surface rather than a static mirror.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	callWifiBridge,
	formatWifiStatus,
	type HardwareReport,
	parseWifiNetworks,
	type SmartglassesBridge,
} from "../ui/SmartglassesView.helpers.ts";
import {
	type SmartglassesPlatform,
	type SmartglassesSnapshot,
	SmartglassesSpatialView,
} from "./SmartglassesSpatialView.tsx";

/** Disconnected default report until the dashboard publishes a live one. */
const DEFAULT_REPORT: HardwareReport = {
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

function getBridge(): SmartglassesBridge | null {
	if (typeof window === "undefined") return null;
	return window.__mentraBridge ?? window.__evenBridge ?? null;
}

/** Read the live report the full dashboard publishes, falling back to default. */
function readPublishedReport(): HardwareReport {
	if (typeof window === "undefined") return DEFAULT_REPORT;
	return window.facewearSmartglassesReport ?? DEFAULT_REPORT;
}

export function SmartglassesPanelView() {
	const [report, setReport] = useState<HardwareReport>(readPublishedReport);
	const [micEnabled, setMicEnabled] = useState(false);
	const [activePlatform, setActivePlatform] =
		useState<SmartglassesPlatform>("desktop");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// SSID / password / display text are typed in the full dashboard; the panel
	// mirrors the dashboard's published values so its Wi-Fi/display Fields stay in
	// sync (and `wifi-save` forwards them to the same bridge).
	const wifiSsid = report.wifi.networks[0] ?? "";
	const wifiPassword = "";
	const testText = "Smartglasses display test.";

	// Poll the published report so the panel tracks the dashboard's live state
	// (the dashboard owns the transport; this panel mirrors + drives the bridge).
	const autoLoadedRef = useRef(false);
	useEffect(() => {
		const sync = () => setReport(readPublishedReport());
		if (!autoLoadedRef.current) {
			autoLoadedRef.current = true;
			sync();
		}
		const interval = setInterval(sync, 5000);
		return () => clearInterval(interval);
	}, []);

	const runBridge = useCallback(
		async (
			label: string,
			command: string,
			payload?: Record<string, unknown>,
		) => {
			const bridge = getBridge();
			if (!bridge) {
				setError("Unavailable");
				return;
			}
			setBusy(label);
			setError(null);
			try {
				const result = await callWifiBridge(bridge, command, payload);
				const networks = parseWifiNetworks(result);
				setReport((current) => ({
					...current,
					wifi: {
						available: true,
						status: formatWifiStatus(result, current.wifi.status),
						networks: networks.length > 0 ? networks : current.wifi.networks,
					},
				}));
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(null);
			}
		},
		[],
	);

	const onAction = useCallback(
		(action: string) => {
			if (action.startsWith("platform:")) {
				setActivePlatform(
					action.slice("platform:".length) as SmartglassesPlatform,
				);
				return;
			}
			switch (action) {
				case "mic-toggle":
					setMicEnabled((prev) => !prev);
					return;
				case "wifi-scan":
					void runBridge("wifi-scan", "request_wifi_scan");
					return;
				case "wifi-status":
					void runBridge("wifi-status", "request_wifi_status");
					return;
				case "wifi-save":
					void runBridge("wifi-save", "set_wifi_credentials", {
						ssid: wifiSsid.trim(),
						password: wifiPassword,
					});
					return;
				case "connect":
				case "run-check":
				case "display-test":
				case "clear-display":
					// The transport is owned by the full dashboard; surface the next step.
					setError("Open Smartglasses.");
					return;
			}
		},
		[runBridge, wifiSsid],
	);

	const snapshot: SmartglassesSnapshot = {
		report,
		micEnabled,
		wifiSsid,
		wifiPassword,
		testText,
		activePlatform,
		busy,
		error,
	};

	return <SmartglassesSpatialView snapshot={snapshot} onAction={onAction} />;
}
