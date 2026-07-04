/**
 * Even bridge transport adapts native Android, desktop, or Mentra bridge calls
 * to the shared smartglasses transport interface.
 */
import {
	encodeMicCommand,
	G1Command,
	type G1Event,
	G1InteractionCode,
	G1SubCommand,
	type GlassSide,
	parseG1Notification,
	type SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";
import type {
	SmartglassesConnectedLenses,
	SmartglassesTransport,
	SmartglassesWifiResult,
} from "./types.ts";

type EvenBridge = {
	requestWifiScan?: () => Promise<unknown> | unknown;
	requestWifiStatus?: () => Promise<unknown> | unknown;
	requestWifiSetup?: (reason?: string) => Promise<unknown> | unknown;
	setWifiCredentials?: (
		ssid: string,
		password: string,
	) => Promise<unknown> | unknown;
	sendWifiCredentials?: (
		ssid: string,
		password: string,
	) => Promise<unknown> | unknown;
	rawBridge?: {
		audioControl?: (enabled: boolean) => Promise<unknown> | unknown;
		callEvenApp?: (
			name: string,
			payload?: Record<string, unknown>,
		) => Promise<unknown> | unknown;
	};
	audioControl?: (enabled: boolean) => Promise<unknown> | unknown;
	createStartUpPageContainer?: (
		container: Record<string, unknown>,
	) => Promise<unknown> | unknown;
	clearDisplay?: () => Promise<unknown> | unknown;
	displayText?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
	onEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
	onEvenHubEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
	rebuildPageContainer?: (
		container: Record<string, unknown>,
	) => Promise<unknown> | unknown;
	sendStartUpPage?: (container: unknown) => Promise<unknown> | unknown;
	setMicState?: (
		sendPcmData: boolean,
		sendTranscript: boolean,
		bypassVad: boolean,
	) => Promise<unknown> | unknown;
	write?: (side: GlassSide, data: Uint8Array) => Promise<unknown> | unknown;
	send?: (side: GlassSide, data: Uint8Array) => Promise<unknown> | unknown;
};

type BridgeSubscription =
	| undefined
	| (() => void)
	| { unsubscribe?: () => void; off?: () => void; remove?: () => void };

function normalizeBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (Array.isArray(value) && value.every((v) => Number.isInteger(v)))
		return Uint8Array.from(value);
	if (
		typeof value === "string" &&
		/^[0-9a-f]+$/i.test(value) &&
		value.length % 2 === 0
	) {
		return Uint8Array.from(
			value.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [],
		);
	}
	return null;
}

export class EvenBridgeTransport implements SmartglassesTransport {
	readonly name = "even-bridge";
	private connected = false;
	private eventCallbacks = new Set<(event: G1Event) => void>();
	private audioCallbacks = new Set<
		(
			audioData: Uint8Array,
			sampleRate: number,
			side: GlassSide,
			encoding?: SmartglassesAudioEncoding,
			sequence?: number,
		) => void
	>();
	private transcriptCallbacks = new Set<
		(text: string, isFinal: boolean, metadata?: Record<string, unknown>) => void
	>();
	private wifiCallbacks = new Set<(status: SmartglassesWifiResult) => void>();
	private bridgeDisposer: (() => void) | null = null;
	private readonly displayChunks = new Map<string, Uint8Array[]>();
	private evenHubStartupCreated = false;

	constructor(private readonly bridge: EvenBridge) {}

	async connect(): Promise<void> {
		this.connected = true;
		const register = this.bridge.onEvenHubEvent ?? this.bridge.onEvent;
		if (register) {
			const subscription = register.call(this.bridge, (event: unknown) =>
				this.handleBridgeEvent(event),
			);
			this.bridgeDisposer = normalizeBridgeSubscription(subscription);
		}
	}

	async disconnect(): Promise<void> {
		await this.openMicrophone(false);
		this.bridgeDisposer?.();
		this.bridgeDisposer = null;
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	getConnectedLenses(): SmartglassesConnectedLenses {
		if (!this.connected) return {};
		return {
			left: {
				connected: true,
				name: "Native bridge left lens",
			},
			right: {
				connected: true,
				name: "Native bridge right lens",
			},
		};
	}

	async write(side: GlassSide, data: Uint8Array): Promise<void> {
		if (this.supportsEvenHubDisplay() && data[0] === G1Command.SendResult) {
			if (side === "left") await this.writeEvenHubDisplay(data);
			return;
		}
		if (this.supportsMentraDisplay() && data[0] === G1Command.SendResult) {
			if (side === "left") await this.writeMentraDisplay(data);
			return;
		}
		if (
			this.bridge.clearDisplay &&
			data[0] === G1Command.StartAi &&
			data[1] === G1SubCommand.Stop
		) {
			await this.bridge.clearDisplay();
			return;
		}
		if (this.bridge.write) {
			await this.bridge.write(side, data);
			return;
		}
		if (this.bridge.send) {
			await this.bridge.send(side, data);
			return;
		}
		await this.bridge.rawBridge?.callEvenApp?.("sendData", {
			side,
			data: Array.from(data),
		});
	}

	async writeBoth(data: Uint8Array): Promise<void> {
		await this.write("left", data);
		await this.write("right", data);
	}

	async openMicrophone(enabled: boolean): Promise<void> {
		if (this.bridge.setMicState) {
			await this.bridge.setMicState(enabled, enabled, enabled);
			return;
		}
		if (this.bridge.audioControl) {
			await this.bridge.audioControl(enabled);
			return;
		}
		if (this.bridge.rawBridge?.audioControl) {
			await this.bridge.rawBridge.audioControl(enabled);
			return;
		}
		if (this.bridge.rawBridge?.callEvenApp) {
			await this.bridge.rawBridge.callEvenApp("audioControl", {
				isOpen: enabled,
			});
			return;
		}
		await this.write("right", encodeMicCommand(enabled));
	}

	async scanWifi(): Promise<SmartglassesWifiResult> {
		this.assertWifiSupported();
		const raw = this.bridge.requestWifiScan
			? await this.bridge.requestWifiScan()
			: await this.bridge.rawBridge?.callEvenApp?.("request_wifi_scan");
		return normalizeWifiResult(raw, "Wi-Fi scan requested");
	}

	async getWifiStatus(): Promise<SmartglassesWifiResult> {
		this.assertWifiSupported();
		const raw = this.bridge.requestWifiStatus
			? await this.bridge.requestWifiStatus()
			: await this.bridge.rawBridge?.callEvenApp?.("request_wifi_status");
		return normalizeWifiResult(raw, "Wi-Fi status requested");
	}

	async configureWifi(
		ssid: string,
		password: string,
	): Promise<SmartglassesWifiResult> {
		this.assertWifiSupported();
		const raw = this.bridge.setWifiCredentials
			? await this.bridge.setWifiCredentials(ssid, password)
			: this.bridge.sendWifiCredentials
				? await this.bridge.sendWifiCredentials(ssid, password)
				: await this.bridge.rawBridge?.callEvenApp?.("set_wifi_credentials", {
						ssid,
						password,
					});
		return normalizeWifiResult(raw, `Wi-Fi credentials sent for ${ssid}`);
	}

	async requestWifiSetup(reason?: string): Promise<SmartglassesWifiResult> {
		this.assertWifiSupported();
		const raw = this.bridge.requestWifiSetup
			? await this.bridge.requestWifiSetup(reason)
			: await this.bridge.rawBridge?.callEvenApp?.("request_wifi_setup", {
					reason,
				});
		return normalizeWifiResult(raw, "Wi-Fi setup requested");
	}

	supportsWifi(): boolean {
		return Boolean(
			this.bridge.requestWifiScan ||
				this.bridge.requestWifiStatus ||
				this.bridge.requestWifiSetup ||
				this.bridge.setWifiCredentials ||
				this.bridge.sendWifiCredentials ||
				this.bridge.rawBridge?.callEvenApp,
		);
	}

	private assertWifiSupported(): void {
		if (!this.supportsWifi()) {
			throw new Error(
				"Wi-Fi is only available when the native smartglasses bridge exposes Wi-Fi APIs",
			);
		}
	}

	private supportsEvenHubDisplay(): boolean {
		return Boolean(
			this.bridge.sendStartUpPage || this.bridge.createStartUpPageContainer,
		);
	}

	private supportsMentraDisplay(): boolean {
		return Boolean(this.bridge.displayText);
	}

	onEvent(callback: (event: G1Event) => void): () => void {
		this.eventCallbacks.add(callback);
		return () => this.eventCallbacks.delete(callback);
	}

	onAudio(
		callback: (
			audioData: Uint8Array,
			sampleRate: number,
			side: GlassSide,
			encoding?: SmartglassesAudioEncoding,
			sequence?: number,
		) => void,
	): () => void {
		this.audioCallbacks.add(callback);
		return () => this.audioCallbacks.delete(callback);
	}

	onTranscript(
		callback: (
			text: string,
			isFinal: boolean,
			metadata?: Record<string, unknown>,
		) => void,
	): () => void {
		this.transcriptCallbacks.add(callback);
		return () => this.transcriptCallbacks.delete(callback);
	}

	onWifiStatus(callback: (status: SmartglassesWifiResult) => void): () => void {
		this.wifiCallbacks.add(callback);
		return () => this.wifiCallbacks.delete(callback);
	}

	private handleBridgeEvent(event: unknown): void {
		const maybe = event as Record<string, unknown>;
		const wifi = normalizeBridgeWifiEvent(maybe);
		if (wifi) {
			for (const callback of this.wifiCallbacks) callback(wifi);
			return;
		}
		const transcript = normalizeBridgeTranscriptEvent(maybe);
		if (transcript) {
			for (const callback of this.transcriptCallbacks)
				callback(transcript.text, transcript.isFinal, transcript.metadata);
			return;
		}
		const audio = maybe.audioEvent as Record<string, unknown> | undefined;
		const audioPcm = normalizeBytes(audio?.audioPcm);
		if (audioPcm) {
			for (const callback of this.audioCallbacks)
				callback(audioPcm, 16_000, "right", "pcm16");
			return;
		}
		const mentraPcm = normalizeBytes(maybe.pcm);
		if (maybe.type === "mic_pcm" && mentraPcm) {
			for (const callback of this.audioCallbacks)
				callback(mentraPcm, 16_000, "right", "pcm16");
			return;
		}
		const mentraLc3 = normalizeBytes(maybe.lc3);
		if (maybe.type === "mic_lc3" && mentraLc3) {
			for (const callback of this.audioCallbacks)
				callback(mentraLc3, 16_000, "right", "lc3");
			return;
		}
		const inputEvent = normalizeEvenHubInputEvent(maybe);
		if (inputEvent) {
			for (const callback of this.eventCallbacks) callback(inputEvent);
			return;
		}
		const side =
			maybe.side === "left" || maybe.side === "right" ? maybe.side : "right";
		const bytes = normalizeBytes(maybe.raw ?? maybe.data ?? maybe.bytes);
		if (!bytes) return;
		const parsed = parseG1Notification(side, bytes);
		for (const callback of this.eventCallbacks) callback(parsed);
		const audioData = parsed.audioPcm ?? parsed.audioData;
		if (audioData) {
			for (const callback of this.audioCallbacks)
				callback(
					audioData,
					16_000,
					parsed.side,
					parsed.audioEncoding,
					parsed.sequence,
				);
		}
	}

	private async writeEvenHubDisplay(data: Uint8Array): Promise<void> {
		const display = this.decodeDisplayPacket(data);
		if (!display) return;
		const key = `${display.seq}:${display.status}:${display.pageNumber}:${display.maxPages}`;
		const chunks =
			this.displayChunks.get(key) ??
			Array.from<Uint8Array>({ length: display.totalPackages });
		chunks[display.currentPackage] = display.chunk;
		this.displayChunks.set(key, chunks);
		if (chunks.some((chunk) => !chunk)) return;

		this.displayChunks.delete(key);
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const textBytes = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			textBytes.set(chunk, offset);
			offset += chunk.length;
		}
		await this.sendEvenHubTextPage(textBytes);
	}

	private async writeMentraDisplay(data: Uint8Array): Promise<void> {
		const display = this.decodeDisplayPacket(data);
		if (!display) return;
		const key = `${display.seq}:${display.status}:${display.pageNumber}:${display.maxPages}`;
		const chunks =
			this.displayChunks.get(key) ??
			Array.from<Uint8Array>({ length: display.totalPackages });
		chunks[display.currentPackage] = display.chunk;
		this.displayChunks.set(key, chunks);
		if (chunks.some((chunk) => !chunk)) return;

		this.displayChunks.delete(key);
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const textBytes = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			textBytes.set(chunk, offset);
			offset += chunk.length;
		}
		await this.bridge.displayText?.({
			text: new TextDecoder().decode(textBytes),
			x: 0,
			y: 0,
			size: 24,
		});
	}

	private async sendEvenHubTextPage(textBytes: Uint8Array): Promise<void> {
		const page = createEvenHubTextPage(textBytes);
		if (this.bridge.sendStartUpPage) {
			await this.bridge.sendStartUpPage(page);
			return;
		}
		if (!this.bridge.createStartUpPageContainer) return;
		if (!this.evenHubStartupCreated) {
			assertEvenHubResult(
				await this.bridge.createStartUpPageContainer(page),
				"createStartUpPageContainer",
			);
			this.evenHubStartupCreated = true;
			return;
		}
		const rebuild =
			this.bridge.rebuildPageContainer ??
			this.bridge.createStartUpPageContainer;
		assertEvenHubResult(
			await rebuild.call(this.bridge, page),
			"rebuildPageContainer",
		);
	}

	private decodeDisplayPacket(data: Uint8Array): {
		seq: number;
		totalPackages: number;
		currentPackage: number;
		status: number;
		pageNumber: number;
		maxPages: number;
		chunk: Uint8Array;
	} | null {
		if (data.length < 9 || data[0] !== G1Command.SendResult) return null;
		const totalPackages = data[2] || 1;
		const currentPackage = data[3] || 0;
		if (currentPackage >= totalPackages) return null;
		return {
			seq: data[1] ?? 0,
			totalPackages,
			currentPackage,
			status: data[4] ?? 0,
			pageNumber: data[7] ?? 1,
			maxPages: data[8] ?? 1,
			chunk: data.slice(9),
		};
	}
}

function normalizeEvenHubInputEvent(
	event: Record<string, unknown>,
): G1Event | null {
	const rawEventType = getEvenHubRawEventType(event);
	const label = normalizeEvenHubEventLabel(rawEventType, event);
	if (!label) return null;
	const code =
		label === "single_tap"
			? G1InteractionCode.SingleTap
			: label === "double_tap"
				? G1InteractionCode.DoubleTap
				: label === "long_press"
					? G1InteractionCode.LongPress
					: G1SubCommand.PageControl;
	return {
		side: "right",
		raw: Uint8Array.from([G1Command.StartAi, code]),
		type: "state",
		code,
		label,
	};
}

function normalizeBridgeTranscriptEvent(event: Record<string, unknown>): {
	text: string;
	isFinal: boolean;
	metadata: Record<string, unknown>;
} | null {
	const type = String(event.type ?? event.streamType ?? "");
	if (
		type !== "local_transcription" &&
		!type.startsWith("transcription") &&
		!("transcript" in event)
	)
		return null;
	const text =
		typeof event.text === "string"
			? event.text
			: typeof event.transcript === "string"
				? event.transcript
				: "";
	if (!text.trim()) return null;
	const isFinal =
		typeof event.isFinal === "boolean"
			? event.isFinal
			: typeof event.final === "boolean"
				? event.final
				: event.type === "local_transcription";
	return { text, isFinal, metadata: { ...event } };
}

function normalizeBridgeWifiEvent(
	event: Record<string, unknown>,
): SmartglassesWifiResult | null {
	const type = String(event.type ?? event.eventType ?? event.event_type ?? "");
	const values =
		event.values && typeof event.values === "object"
			? (event.values as Record<string, unknown>)
			: event;
	const hasWifiFields =
		"wifiConnected" in values ||
		"wifiSsid" in values ||
		"wifiLocalIp" in values ||
		"connected" in values ||
		"ssid" in values ||
		"networks" in values ||
		"results" in values;
	if (
		type !== "wifi_status_change" &&
		type !== "wifi_status" &&
		type !== "wifi_scan_result" &&
		!hasWifiFields
	) {
		return null;
	}
	const connected =
		booleanValue(values.wifiConnected) ?? booleanValue(values.connected);
	const ssid = stringValue(values.wifiSsid) ?? stringValue(values.ssid);
	const localIp =
		stringValue(values.wifiLocalIp) ?? stringValue(values.localIp);
	const networks = parseWifiNetworks(values);
	const status =
		parseWifiStatus(values) ??
		(type === "wifi_scan_result"
			? networks.length > 0
				? `found ${networks.length} Wi-Fi network(s)`
				: "Wi-Fi scan result"
			: connected
				? `connected to ${ssid ?? "Wi-Fi"}`
				: connected === false
					? "disconnected"
					: "Wi-Fi status updated");
	return {
		available: true,
		status,
		networks,
		raw: { ...event, normalized: { connected, ssid, localIp } },
	};
}

function getEvenHubRawEventType(event: Record<string, unknown>): unknown {
	const jsonData = normalizeJsonData(event.jsonData);
	return (
		getNestedEventType(event.listEvent) ??
		getNestedEventType(event.textEvent) ??
		getNestedEventType(event.sysEvent) ??
		event.eventType ??
		jsonData?.eventType ??
		jsonData?.event_type ??
		jsonData?.Event_Type ??
		jsonData?.type ??
		event.type ??
		event.action
	);
}

function normalizeJsonData(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object")
		return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function getNestedEventType(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	return event.eventType ?? event.event_type ?? event.Event_Type ?? event.type;
}

function normalizeEvenHubEventLabel(
	rawEventType: unknown,
	event: Record<string, unknown>,
):
	| "single_tap"
	| "double_tap"
	| "long_press"
	| "scroll_up"
	| "scroll_down"
	| null {
	if (
		rawEventType === undefined &&
		(event.listEvent || event.textEvent || event.sysEvent)
	)
		return "single_tap";
	if (typeof rawEventType === "number") {
		if (rawEventType === 0) return "single_tap";
		if (rawEventType === 1) return "scroll_up";
		if (rawEventType === 2) return "scroll_down";
		if (rawEventType === 3) return "double_tap";
		return null;
	}
	if (typeof rawEventType === "string") {
		const value = rawEventType.toUpperCase();
		if (value.includes("LONG")) return "long_press";
		if (value.includes("DOUBLE")) return "double_tap";
		if (value.includes("SCROLL_TOP") || value.includes("SCROLL_UP"))
			return "scroll_up";
		if (value.includes("SCROLL_BOTTOM") || value.includes("SCROLL_DOWN"))
			return "scroll_down";
		if (value === "UP") return "scroll_up";
		if (value === "DOWN") return "scroll_down";
		if (value.includes("CLICK") || value.includes("TAP")) return "single_tap";
		if (value === "BUTTON_PRESS") return normalizeButtonPressEvent(event);
	}
	return normalizeButtonPressEvent(event);
}

function normalizeButtonPressEvent(
	event: Record<string, unknown>,
):
	| "single_tap"
	| "double_tap"
	| "long_press"
	| "scroll_up"
	| "scroll_down"
	| null {
	const buttonValue = String(
		event.pressType ?? event.button ?? event.buttonId ?? event.value ?? "",
	).toUpperCase();
	if (buttonValue.includes("LONG")) return "long_press";
	if (buttonValue.includes("DOUBLE")) return "double_tap";
	if (buttonValue.includes("SCROLL_TOP") || buttonValue.includes("UP"))
		return "scroll_up";
	if (buttonValue.includes("SCROLL_BOTTOM") || buttonValue.includes("DOWN"))
		return "scroll_down";
	if (buttonValue.includes("SINGLE") || buttonValue.includes("TAP"))
		return "single_tap";
	return null;
}

function normalizeBridgeSubscription(
	subscription: BridgeSubscription,
): (() => void) | null {
	if (typeof subscription === "function") return subscription;
	if (!subscription || typeof subscription !== "object") return null;
	return (
		subscription.unsubscribe?.bind(subscription) ??
		subscription.off?.bind(subscription) ??
		subscription.remove?.bind(subscription) ??
		null
	);
}

function normalizeWifiResult(
	raw: unknown,
	fallbackStatus: string,
): SmartglassesWifiResult {
	return {
		available: true,
		status: parseWifiStatus(raw) ?? fallbackStatus,
		networks: parseWifiNetworks(raw),
		raw,
	};
}

function parseWifiStatus(raw: unknown): string | null {
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const value =
		record.status ??
		record.state ??
		record.message ??
		record.result ??
		record.connectedSsid ??
		record.ssid;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		if (/^(true|1|yes|connected)$/i.test(value)) return true;
		if (/^(false|0|no|disconnected)$/i.test(value)) return false;
	}
	return null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseWifiNetworks(raw: unknown): string[] {
	if (!raw || typeof raw !== "object") return [];
	const record = raw as Record<string, unknown>;
	const value = record.networks ?? record.networks_neo ?? record.results;
	if (!Array.isArray(value)) return [];
	return value
		.map((network) => {
			if (typeof network === "string") return network;
			if (!network || typeof network !== "object") return "";
			const item = network as Record<string, unknown>;
			return String(item.ssid ?? item.SSID ?? item.name ?? "");
		})
		.filter((ssid) => ssid.trim().length > 0);
}

function createEvenHubTextPage(textBytes: Uint8Array): Record<string, unknown> {
	const text = new TextDecoder().decode(textBytes);
	return {
		containerTotalNum: 2,
		text,
		textObject: [
			{
				containerID: 1,
				containerName: "eliza-smartglasses-text",
				content: text,
				xPosition: 12,
				yPosition: 12,
				width: 552,
				height: 200,
				isEventCapture: 0,
			},
		],
		listObject: [
			{
				containerID: 2,
				containerName: "eliza-smartglasses-input",
				itemContainer: {
					itemCount: 1,
					itemWidth: 552,
					isItemSelectBorderEn: 0,
					itemName: ["Click mic on | Double click mic off"],
				},
				isEventCapture: 1,
				xPosition: 12,
				yPosition: 236,
				width: 552,
				height: 36,
			},
		],
	};
}

function assertEvenHubResult(result: unknown, operation: string): void {
	if (typeof result === "number" && result !== 0) {
		throw new Error(`${operation} failed with result ${result}`);
	}
	if (typeof result === "boolean" && !result) {
		throw new Error(`${operation} failed`);
	}
}

export function getGlobalEvenBridgeTransport(): SmartglassesTransport | null {
	const globalBridge = (globalThis as Record<string, unknown>).__evenBridge as
		| EvenBridge
		| undefined;
	return globalBridge ? new EvenBridgeTransport(globalBridge) : null;
}
