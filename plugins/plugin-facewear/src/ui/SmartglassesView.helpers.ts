/**
 * Smartglasses view helpers derive diagnostics reports, Wi-Fi bridge output,
 * display packets, and setup guidance outside the React component module.
 */

import {
	type DisplayPage,
	encodeTextPackets,
	G1AiStatus,
	G1ScreenAction,
	G1TextStatus,
	type GlassSide,
	paginateDisplayText,
	type SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";

export type LensState = "idle" | "prompting" | "connected" | "failed";
export type ViewScanDiagnosis =
	| "not_scanned"
	| "left_lens_missing"
	| "right_lens_missing"
	| "whole_headset_seen"
	| "pairing_failed";
export type ViewPhysicalBlocker =
	| "not_connected"
	| "partial_headset"
	| "in_charging_base"
	| "wearing_state_missing"
	| "evidence_missing"
	| null;

export interface ReportEvent {
	at: string;
	type: string;
	detail: string;
}

export interface ReportWrite {
	at: string;
	side: GlassSide | "both";
	command: string;
	bytes: number;
	hex: string;
}

export interface ReportAudio {
	at: string;
	side: GlassSide;
	sampleRate: number;
	encoding: SmartglassesAudioEncoding | null;
	sequence?: number;
	bytes: number;
}

export interface HardwareReport {
	ok: boolean;
	generatedAt: string;
	transport: string | null;
	connected: boolean;
	lenses: Record<GlassSide, LensState>;
	scanDiagnosis: ViewScanDiagnosis;
	physicalBlocker: ViewPhysicalBlocker;
	setupHint: string | null;
	nextAction: string | null;
	serialNumber: string | null;
	tests: Record<string, boolean>;
	missingEvidence: string[];
	events: ReportEvent[];
	writes: ReportWrite[];
	audio: ReportAudio[];
	wifi: {
		available: boolean;
		status: string;
		networks: string[];
	};
	headsetState: {
		physical: string | null;
		battery: string | null;
		batteryLevels: Partial<Record<GlassSide, number>>;
		device: string | null;
	};
}

type BridgeResult = unknown;
type BridgeSubscription =
	| undefined
	| (() => void)
	| { unsubscribe?: () => void; off?: () => void; remove?: () => void };

export type SmartglassesBridge = {
	requestWifiScan?: () => Promise<BridgeResult> | BridgeResult;
	requestWifiStatus?: () => Promise<BridgeResult> | BridgeResult;
	requestWifiSetup?: (reason?: string) => Promise<BridgeResult> | BridgeResult;
	setWifiCredentials?: (
		ssid: string,
		password: string,
	) => Promise<BridgeResult> | BridgeResult;
	sendWifiCredentials?: (
		ssid: string,
		password: string,
	) => Promise<BridgeResult> | BridgeResult;
	audioControl?: (enabled: boolean) => Promise<BridgeResult> | BridgeResult;
	clearDisplay?: () => Promise<BridgeResult> | BridgeResult;
	createStartUpPageContainer?: (
		container: Record<string, unknown>,
	) => Promise<BridgeResult> | BridgeResult;
	displayText?: (
		params: Record<string, unknown>,
	) => Promise<BridgeResult> | BridgeResult;
	onEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
	onEvenHubEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
	rebuildPageContainer?: (
		container: Record<string, unknown>,
	) => Promise<BridgeResult> | BridgeResult;
	sendStartUpPage?: (
		container: unknown,
	) => Promise<BridgeResult> | BridgeResult;
	setMicState?: (
		sendPcmData: boolean,
		sendTranscript: boolean,
		bypassVad: boolean,
	) => Promise<BridgeResult> | BridgeResult;
	write?: (
		side: GlassSide,
		data: Uint8Array,
	) => Promise<BridgeResult> | BridgeResult;
	send?: (
		side: GlassSide,
		data: Uint8Array,
	) => Promise<BridgeResult> | BridgeResult;
	rawBridge?: {
		audioControl?: (enabled: boolean) => Promise<BridgeResult> | BridgeResult;
		callEvenApp?: (
			name: string,
			payload?: Record<string, unknown>,
		) => Promise<BridgeResult> | BridgeResult;
	};
};

export function isMicEnableTap(label?: string | null): boolean {
	return label === "single_tap" || label === "long_press";
}

export function isMicDisableTap(label?: string | null): boolean {
	return label === "double_tap" || label === "stop_ai_recording";
}

function reportTimeMs(value: string): number | null {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function reportHappenedAfter(
	later: { at: string },
	earlier: { at: string },
): boolean {
	const laterMs = reportTimeMs(later.at);
	const earlierMs = reportTimeMs(earlier.at);
	return laterMs !== null && earlierMs !== null ? laterMs >= earlierMs : false;
}

function hasTapDrivenViewMicWrite(
	events: ReportEvent[],
	writes: ReportWrite[],
	mode: "enable" | "disable",
): boolean {
	const isTap = mode === "enable" ? isMicEnableTap : isMicDisableTap;
	const expectedHex = mode === "enable" ? "0e01" : "0e00";
	const tapEvents = events.filter((event) => isTap(event.detail));
	const micWrites = writes.filter(
		(write) =>
			write.side === "right" &&
			write.command === "open-mic" &&
			write.hex.startsWith(expectedHex),
	);
	return tapEvents.some((event) =>
		micWrites.some((write) => reportHappenedAfter(write, event)),
	);
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

export function headsetValidationBlocker(
	physicalState: string | null,
	batteryState: string | null,
): string | null {
	if (physicalState === "wearing") return null;
	const stateText =
		[physicalState, batteryState].filter(Boolean).join(" / ") ||
		"no wearing state observed";
	if (isCradleOrChargingState(physicalState, batteryState)) {
		return `Glasses are still reporting ${stateText}. Remove them from the charging base and wear them before tap or microphone validation.`;
	}
	return `Tap and microphone validation requires a wearing state; current state is ${stateText}.`;
}

export function missingViewEvidence(
	tests: Record<string, boolean>,
	lenses: Record<GlassSide, LensState>,
	physicalState: string | null,
	batteryState: string | null,
	events: ReportEvent[] = [],
	writes: ReportWrite[] = [],
): string[] {
	const hasTapDrivenEnableWrite = hasTapDrivenViewMicWrite(
		events,
		writes,
		"enable",
	);
	const hasTapDrivenDisableWrite = hasTapDrivenViewMicWrite(
		events,
		writes,
		"disable",
	);
	const missing = [
		lenses.left !== "connected" && "leftLensConnected",
		lenses.right !== "connected" && "rightLensConnected",
		physicalState !== "wearing" && "wearingStateObserved",
		isCradleOrChargingState(physicalState, batteryState) && "headsetInCradle",
		!tests.init && "connectionReadySent",
		!tests.display && "displayPacketsSent",
		!tests.serial && "serialRequested",
		!tests.serialObserved && "serialObserved",
		!tests.settings && "settingsSent",
		!hasTapDrivenEnableWrite && "rightMicEnableWrite",
		!hasTapDrivenDisableWrite && "rightMicDisableWrite",
		!tests.tapMicEnable && "tapMicEnable",
		!tests.tapMicDisable && "tapMicDisable",
		!tests.audio && "rightOrBridgeAudio",
	].filter((value): value is string => typeof value === "string");
	return [...new Set(missing)];
}

export function viewScanDiagnosis(
	lenses: Record<GlassSide, LensState>,
): ViewScanDiagnosis {
	if (lenses.left === "connected" && lenses.right === "connected") {
		return "whole_headset_seen";
	}
	if (lenses.left === "failed" || lenses.right === "failed") {
		return "pairing_failed";
	}
	if (lenses.left === "connected") return "right_lens_missing";
	if (lenses.right === "connected") return "left_lens_missing";
	return "not_scanned";
}

export function viewPhysicalBlocker(
	tests: Record<string, boolean>,
	lenses: Record<GlassSide, LensState>,
	physicalState: string | null,
	batteryState: string | null,
	events: ReportEvent[] = [],
	writes: ReportWrite[] = [],
): ViewPhysicalBlocker {
	const wholeHeadset =
		lenses.left === "connected" && lenses.right === "connected";
	if (
		!wholeHeadset &&
		(lenses.left === "connected" || lenses.right === "connected")
	) {
		return "partial_headset";
	}
	if (!wholeHeadset) return "not_connected";
	if (isCradleOrChargingState(physicalState, batteryState)) {
		return "in_charging_base";
	}
	if (physicalState !== "wearing") return "wearing_state_missing";
	return missingViewEvidence(
		tests,
		lenses,
		physicalState,
		batteryState,
		events,
		writes,
	).length
		? "evidence_missing"
		: null;
}

export function viewSetupHint(
	blocker: ViewPhysicalBlocker,
	physicalState: string | null,
	batteryState: string | null,
): string | null {
	if (blocker === "not_connected") {
		return "Connect both left and right lenses as one headset before running validation.";
	}
	if (blocker === "partial_headset") {
		return "Reconnect the whole headset so both left and right lenses are present.";
	}
	if (blocker === "in_charging_base" || blocker === "wearing_state_missing") {
		return headsetValidationBlocker(physicalState, batteryState);
	}
	if (blocker === "evidence_missing") {
		return "Run check, then guided validation to capture display, settings, side taps, mic writes, and audio.";
	}
	return null;
}

export function viewNextAction(blocker: ViewPhysicalBlocker): string | null {
	if (blocker === "not_connected") return "Connect Headset";
	if (blocker === "partial_headset") return "Reconnect the missing lens";
	if (blocker === "in_charging_base") {
		return "Remove the glasses from the charging base and wear them";
	}
	if (blocker === "wearing_state_missing") {
		return "Wear the glasses until wearing state appears";
	}
	if (blocker === "evidence_missing") return "Run Check and Guided Validation";
	return null;
}

export function viewCommandName(data: Uint8Array): string {
	switch (data[0]) {
		case 0x01:
			return "brightness";
		case 0x0e:
			return "open-mic";
		case 0x1c:
			return "silent-mode";
		case 0x2c:
			return "battery-status";
		case 0x34:
			return "get-serial";
		case 0x4d:
			return "init";
		case 0x4e:
			return "display-result";
		case 0xf4:
			return "right-init";
		default:
			return data.length > 0
				? `0x${data[0].toString(16).padStart(2, "0")}`
				: "empty";
	}
}

function withViewScreenStatus(
	page: DisplayPage,
	screenStatus: number,
): DisplayPage {
	return { ...page, screenStatus };
}

function viewStreamingStatus(mode: "ai" | "text", pageIndex: number): number {
	if (mode === "text") return G1TextStatus.TextShow | G1ScreenAction.NewContent;
	return pageIndex === 0
		? G1AiStatus.Displaying | G1ScreenAction.NewContent
		: G1AiStatus.Displaying;
}

export function buildViewDisplayPackets(
	text: string,
	options: {
		startSeq?: number;
		mode?: "ai" | "text";
		includeCompletion?: boolean;
	} = {},
): { packets: Uint8Array[]; pages: number; nextSeq: number } {
	const mode = options.mode ?? "ai";
	let seq = options.startSeq ?? 0;
	const packets: Uint8Array[] = [];
	const pages = paginateDisplayText(text);
	for (const [pageIndex, page] of pages.entries()) {
		packets.push(
			...encodeTextPackets(
				withViewScreenStatus(page, viewStreamingStatus(mode, pageIndex)),
				seq,
			),
		);
		seq = (seq + 1) & 0xff;
	}
	if (mode !== "text" && options.includeCompletion !== false) {
		const lastPage = pages.at(-1);
		if (lastPage) {
			packets.push(
				...encodeTextPackets(
					withViewScreenStatus(lastPage, G1AiStatus.DisplayComplete),
					seq,
				),
			);
			seq = (seq + 1) & 0xff;
		}
	}
	return { packets, pages: pages.length, nextSeq: seq };
}

export function parseWifiNetworks(result: unknown): string[] {
	if (!result || typeof result !== "object") return [];
	const value = result as Record<string, unknown>;
	const networks =
		value.networks ??
		value.wifiNetworks ??
		value.accessPoints ??
		value.networks_neo ??
		value.results;
	if (!Array.isArray(networks)) return [];
	return networks
		.map((network) => {
			if (typeof network === "string") return network;
			if (network && typeof network === "object") {
				const record = network as Record<string, unknown>;
				return String(record.ssid ?? record.SSID ?? record.name ?? "");
			}
			return "";
		})
		.map((network) => network.trim())
		.filter((network) => network.length > 0);
}

export function formatWifiStatus(
	result: unknown,
	fallback = "Wi-Fi status requested",
): string {
	if (!result || typeof result !== "object") return fallback;
	const value = result as Record<string, unknown>;
	const explicitStatus = value.status ?? value.state ?? value.message;
	if (typeof explicitStatus === "string" && explicitStatus.trim()) {
		return explicitStatus.trim();
	}
	const connected = value.connected ?? value.wifiConnected;
	const ssid = value.ssid ?? value.wifiSsid ?? value.SSID;
	const localIp = value.localIp ?? value.wifiLocalIp ?? value.ipAddress;
	if (connected === true) {
		return `Connected to ${String(ssid ?? "Wi-Fi")}${
			localIp ? ` at ${String(localIp)}` : ""
		}`;
	}
	if (connected === false) return "Wi-Fi disconnected";
	return fallback;
}

export async function callWifiBridge(
	bridge: SmartglassesBridge,
	command: string,
	payload?: Record<string, unknown>,
): Promise<unknown> {
	if (command === "request_wifi_scan" && bridge.requestWifiScan) {
		return bridge.requestWifiScan();
	}
	if (command === "request_wifi_status" && bridge.requestWifiStatus) {
		return bridge.requestWifiStatus();
	}
	if (command === "request_wifi_setup" && bridge.requestWifiSetup) {
		return bridge.requestWifiSetup(String(payload?.reason ?? ""));
	}
	if (command === "set_wifi_credentials") {
		const ssid = String(payload?.ssid ?? "");
		const password = String(payload?.password ?? "");
		if (bridge.setWifiCredentials) {
			return bridge.setWifiCredentials(ssid, password);
		}
		if (bridge.sendWifiCredentials) {
			return bridge.sendWifiCredentials(ssid, password);
		}
	}
	if (bridge.rawBridge?.callEvenApp) {
		return bridge.rawBridge.callEvenApp(command, payload);
	}
	throw new Error(
		`Native smartglasses bridge does not support Wi-Fi command: ${command}`,
	);
}
