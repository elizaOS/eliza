/**
 * XR session service hosts the headset WebSocket server and bridges control,
 * audio, camera, view, and smartglasses frames into the agent runtime.
 */
import type {
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	UUID,
} from "@elizaos/core";
import {
	ChannelType,
	createMessageMemory,
	logger,
	ModelType,
	Service,
} from "@elizaos/core";
import { type WebSocket, WebSocketServer } from "ws";
import type {
	G1Event,
	SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";
import {
	decodeBinaryFrame,
	encodeBinaryFrame,
	type XRClientControl,
	type XRDeviceType,
	type XRPanelConfig,
	type XRServerControl,
	type XRTTSAudioHeader,
} from "../protocol/xr.ts";
import { AudioPipeline } from "./audio-pipeline.ts";
import { getSmartglassesService } from "./smartglasses-service.ts";
import { VisionPipeline } from "./vision-pipeline.ts";

export const XR_SERVICE_TYPE = "xr-session";
export const XR_WS_PORT_DEFAULT = 31338;
export const XR_WS_PORT_ENV = "XR_WS_PORT";

type WebSocketRawData = Buffer | ArrayBuffer | Buffer[];

export interface XRConnection {
	id: string;
	ws: WebSocket;
	deviceType: XRDeviceType;
	entityId: UUID;
	roomId: UUID;
	connectedAt: Date;
}

function rawDataToBuffer(data: WebSocketRawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

export class XRSessionService extends Service {
	static override serviceType = XR_SERVICE_TYPE;

	readonly capabilityDescription =
		"Streams audio and camera from XR headsets (Quest 3, XReal) to the agent and returns voice responses.";

	private wss!: WebSocketServer;
	private connections = new Map<string, XRConnection>();
	private audioPipeline!: AudioPipeline;
	private visionPipeline!: VisionPipeline;

	static override async start(runtime: IAgentRuntime): Promise<Service> {
		const svc = new XRSessionService(runtime);
		await svc.initialize(runtime);
		return svc;
	}

	private async initialize(runtime: IAgentRuntime): Promise<void> {
		this.visionPipeline = new VisionPipeline();
		this.audioPipeline = new AudioPipeline(
			runtime,
			(connectionId, transcript) =>
				this.handleTranscript(connectionId, transcript),
		);

		const port = Number(
			runtime.getSetting(XR_WS_PORT_ENV) ?? XR_WS_PORT_DEFAULT,
		);
		this.wss = new WebSocketServer({ port });

		this.wss.on("connection", (ws: WebSocket) => this.onConnect(runtime, ws));
		this.wss.on("error", (err: Error) =>
			runtime.reportError("XRSessionService.wss", err),
		);

		logger.info(
			`[XRSessionService] WebSocket server listening on ws://localhost:${port}`,
		);
	}

	override async stop(): Promise<void> {
		for (const conn of this.connections.values()) {
			this.audioPipeline.clear(conn.id);
			this.visionPipeline.clear(conn.id);
			conn.ws.close();
		}
		this.connections.clear();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
	}

	// ── Public accessors used by provider / action ──────────────────────────

	getConnections(): XRConnection[] {
		return [...this.connections.values()];
	}

	getWebSocketPort(): number | null {
		const address = this.wss.address();
		return typeof address === "object" && address ? address.port : null;
	}

	hasActiveConnections(): boolean {
		return this.connections.size > 0;
	}

	getVisionPipeline(): VisionPipeline {
		return this.visionPipeline;
	}

	sendText(connectionId: string, text: string): void {
		const conn = this.connections.get(connectionId);
		if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
		conn.ws.send(JSON.stringify({ type: "agent_text", text }));
	}

	sendControl(connectionId: string, msg: XRServerControl): void {
		const conn = this.connections.get(connectionId);
		if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
		conn.ws.send(JSON.stringify(msg));
	}

	broadcastControl(msg: XRServerControl): void {
		for (const conn of this.connections.values()) {
			if (conn.ws.readyState === conn.ws.OPEN) {
				conn.ws.send(JSON.stringify(msg));
			}
		}
	}

	openView(
		connectionId: string,
		viewId: string,
		agentBaseUrl: string,
		config?: XRPanelConfig,
	): void {
		this.sendControl(connectionId, {
			type: "view_open",
			viewId,
			agentBaseUrl,
			config,
		});
	}

	closeView(connectionId: string, viewId: string): void {
		this.sendControl(connectionId, { type: "view_close", viewId });
	}

	switchView(connectionId: string, viewId: string): void {
		this.sendControl(connectionId, { type: "view_switch", viewId });
	}

	resizeView(
		connectionId: string,
		viewId: string,
		config: XRPanelConfig,
	): void {
		this.sendControl(connectionId, { type: "view_resize", viewId, config });
	}

	sendViewsCatalog(
		connectionId: string,
		views: Array<{
			id: string;
			label: string;
			icon?: string;
			description?: string;
		}>,
	): void {
		this.sendControl(connectionId, { type: "views_catalog", views });
	}

	sendAudio(connectionId: string, audio: Buffer, sampleRate = 24000): void {
		const conn = this.connections.get(connectionId);
		if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
		const header: XRTTSAudioHeader = {
			type: "tts_audio",
			sampleRate,
			channels: 1,
			encoding: "mp3",
		};
		conn.ws.send(encodeBinaryFrame(header, audio), { binary: true });
	}

	// ── WebSocket connection lifecycle ──────────────────────────────────────

	private onConnect(runtime: IAgentRuntime, ws: WebSocket): void {
		const connId = crypto.randomUUID();

		ws.on("message", (data: WebSocketRawData, isBinary: boolean) => {
			try {
				const payload = rawDataToBuffer(data);
				if (isBinary) {
					this.handleBinaryMessage(connId, payload);
				} else {
					this.handleTextMessage(runtime, connId, ws, payload.toString("utf8"));
				}
			} catch (err) {
				// error-policy:J1 per-message transport boundary — a single
				// malformed/failed frame must not tear down the ws message loop;
				// reportError surfaces it to the agent/owner.
				runtime.reportError("XRSessionService.message", err, { connId });
			}
		});

		ws.on("close", () => {
			this.audioPipeline.flush(connId);
			this.audioPipeline.clear(connId);
			this.visionPipeline.clear(connId);
			this.connections.delete(connId);
			logger.info(`[XRSessionService] device disconnected: ${connId}`);
		});

		ws.on("error", (err: Error) =>
			logger.warn({ err, connId }, "[XRSessionService] ws connection error"),
		);
	}

	private handleTextMessage(
		runtime: IAgentRuntime,
		connId: string,
		ws: WebSocket,
		raw: string,
	): void {
		const msg = JSON.parse(raw) as XRClientControl;

		if (msg.type === "hello") {
			const entityId = crypto.randomUUID() as UUID;
			const roomId = crypto.randomUUID() as UUID;
			const conn: XRConnection = {
				id: connId,
				ws,
				deviceType: msg.deviceType,
				entityId,
				roomId,
				connectedAt: new Date(),
			};
			this.connections.set(connId, conn);
			ws.send(JSON.stringify({ type: "ready", sessionId: connId }));
			void this.ensureEntities(runtime, conn);
			logger.info(`[XRSessionService] ${msg.deviceType} connected: ${connId}`);
			return;
		}

		if (msg.type === "ping") {
			ws.send(JSON.stringify({ type: "pong" }));
			return;
		}

		if (msg.type === "g1_raw") {
			void this.handleSmartglassesRaw(runtime, connId, msg);
			return;
		}

		if (msg.type === "mic_lc3" || msg.type === "mic_pcm") {
			void this.handleSmartglassesAudio(runtime, msg);
			return;
		}

		if (msg.type === "view_ready") {
			logger.info(`[XRSessionService] view ready on ${connId}: ${msg.viewId}`);
			return;
		}

		if (msg.type === "view_closed") {
			logger.info(`[XRSessionService] view closed on ${connId}: ${msg.viewId}`);
			return;
		}

		if (msg.type === "view_event") {
			logger.info(
				{ connId, viewId: msg.viewId, event: msg.event },
				"[XRSessionService] view event",
			);
			return;
		}
	}

	private async handleSmartglassesRaw(
		runtime: IAgentRuntime,
		connId: string,
		msg: {
			type: "g1_raw";
			side?: "left" | "right";
			data?: number[];
			base64?: string;
		},
	): Promise<void> {
		const service = getSmartglassesService(runtime);
		if (!service) return;
		const data = bytesFromMessagePayload(msg.data, msg.base64);
		if (!data) return;
		const side = msg.side ?? "right";
		const event = await service.receiveExternalRawEvent(side, data, {
			applyControls: false,
		});
		this.sendSmartglassesControl(connId, event);
	}

	private async handleSmartglassesAudio(
		runtime: IAgentRuntime,
		msg: {
			type: "mic_lc3" | "mic_pcm";
			side?: "left" | "right";
			sampleRate?: number;
			sequence?: number;
			lc3?: number[];
			pcm?: number[];
			base64?: string;
		},
	): Promise<void> {
		const service = getSmartglassesService(runtime);
		if (!service) return;
		const data = bytesFromMessagePayload(
			msg.type === "mic_pcm" ? msg.pcm : msg.lc3,
			msg.base64,
		);
		if (!data) return;
		await service.receiveExternalAudioChunk(data, {
			sampleRate: msg.sampleRate,
			side: msg.side ?? "right",
			encoding: smartglassesEncodingForMessage(msg.type),
			sequence: msg.sequence,
		});
	}

	private sendSmartglassesControl(connId: string, event: G1Event): void {
		const conn = this.connections.get(connId);
		if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
		if (conn.deviceType !== "even-realities") return;
		if (event.label === "single_tap" || event.label === "long_press") {
			conn.ws.send(JSON.stringify({ type: "mic_control", enabled: true }));
		}
		if (event.label === "double_tap" || event.label === "stop_ai_recording") {
			conn.ws.send(JSON.stringify({ type: "mic_control", enabled: false }));
		}
	}

	private handleBinaryMessage(connId: string, data: Buffer): void {
		const conn = this.connections.get(connId);
		if (!conn) return;

		const { header, payload } = decodeBinaryFrame(data);

		if (header.type === "audio") {
			this.audioPipeline.push(connId, header, payload);
			return;
		}

		if (header.type === "frame") {
			this.visionPipeline.storeFrame(connId, header, payload);
			return;
		}
	}

	// ── Message routing ─────────────────────────────────────────────────────

	private async handleTranscript(
		connectionId: string,
		transcript: string,
	): Promise<void> {
		const conn = this.connections.get(connectionId);
		if (!conn) return;
		const runtime = this.runtime;

		// Echo transcript back so the UI can show it
		conn.ws.send(
			JSON.stringify({ type: "transcript", text: transcript, final: true }),
		);

		// Attach latest camera frame as image attachment if available
		const latestFrame = this.visionPipeline.getLatestFrame(connectionId);
		const attachments: Content["attachments"] = latestFrame
			? [
					{
						id: crypto.randomUUID(),
						url: `data:image/${latestFrame.header.format};base64,${latestFrame.data.toString("base64")}`,
						title: "XR camera frame",
						contentType: "image",
						source: "xr-camera",
					},
				]
			: [];

		const memory = createMessageMemory({
			entityId: conn.entityId,
			agentId: runtime.agentId,
			roomId: conn.roomId,
			content: {
				text: transcript,
				source: `xr-${conn.deviceType}`,
				attachments,
			},
		});

		await runtime.createMemory(memory, "messages");

		const callback: HandlerCallback = async (
			response: Content,
		): Promise<Memory[]> => {
			const text = response.text?.trim() ?? "";
			if (text.length === 0) return [];

			// Send text response immediately
			conn.ws.send(JSON.stringify({ type: "agent_text", text }));

			// Generate TTS and send audio
			try {
				const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, text);
				const audioBuf = Buffer.isBuffer(audio)
					? audio
					: Buffer.from(audio as ArrayBuffer);
				this.sendAudio(connectionId, audioBuf);
			} catch (err) {
				// error-policy:J7 the text reply is already delivered; TTS is a
				// background enhancement whose failure must surface but must not
				// block persisting the agent response memory below.
				logger.warn({ err, connectionId }, "[XRSessionService] TTS failed");
				runtime.reportError("XRSessionService.tts", err, { connectionId });
			}

			// Persist agent response as memory
			const responseMemory = createMessageMemory({
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				roomId: conn.roomId,
				content: { text, source: `xr-agent`, inReplyTo: memory.id },
			});
			await runtime.createMemory(responseMemory, "messages");
			return [responseMemory];
		};

		if (runtime.messageService) {
			await runtime.messageService.handleMessage(runtime, memory, callback);
		}
	}

	// ── Entity / room bootstrap ─────────────────────────────────────────────

	private async ensureEntities(
		runtime: IAgentRuntime,
		conn: XRConnection,
	): Promise<void> {
		try {
			await runtime.createEntity({
				id: conn.entityId,
				agentId: runtime.agentId,
				names: [`XR-${conn.deviceType}`],
				metadata: { source: `xr-${conn.deviceType}` },
			});
			await runtime.createRoom({
				id: conn.roomId,
				name: `XR session (${conn.deviceType} ${conn.id.slice(0, 8)})`,
				source: "xr",
				type: ChannelType.GROUP,
				channelId: undefined,
				messageServerId: undefined,
			});
			await runtime.addParticipant(conn.entityId, conn.roomId);
			await runtime.addParticipant(runtime.agentId, conn.roomId);
		} catch (err) {
			// error-policy:J7 fire-and-forget bootstrap (called via `void`); a
			// failure here breaks downstream memory writes for this session, so
			// surface it observably rather than swallowing it silently.
			runtime.reportError("XRSessionService.ensureEntities", err, {
				connId: conn.id,
			});
		}
	}
}

function bytesFromMessagePayload(
	bytes?: number[],
	base64?: string,
): Uint8Array | null {
	if (Array.isArray(bytes) && bytes.every((value) => Number.isInteger(value))) {
		return Uint8Array.from(bytes.map((value) => value & 0xff));
	}
	if (typeof base64 === "string" && base64.trim()) {
		return Uint8Array.from(Buffer.from(base64, "base64"));
	}
	return null;
}

function smartglassesEncodingForMessage(
	type: "mic_lc3" | "mic_pcm",
): SmartglassesAudioEncoding {
	return type === "mic_pcm" ? "pcm16" : "lc3";
}
