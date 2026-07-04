/**
 * Integration tests: DeviceEmulator connects over WebSocket and exchanges XR protocol messages.
 *
 * Each test spins up a raw WebSocketServer on a random port, implements the XR
 * handshake (hello → ready, ping → pong, binary frame decode), and drives the
 * DeviceEmulator against it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import {
	DeviceEmulator,
	type FacewearDeviceType,
} from "../../emulator/src/device-emulator.ts";
import { decodeBinaryFrame } from "../protocol/xr.ts";

// ── Minimal XR protocol server ────────────────────────────────────────────────

interface ReceivedBinary {
	header: ReturnType<typeof decodeBinaryFrame>["header"];
	payload: Buffer;
}

interface TestServer {
	wss: WebSocketServer;
	port: number;
	/** Text messages received from the client (parsed JSON). */
	receivedText: unknown[];
	/** Binary frames received and decoded. */
	receivedBinary: ReceivedBinary[];
	/** Resolves once a client connects and the socket is available. */
	waitForClient(): Promise<WebSocket>;
	/** Send a text message to the currently connected client. */
	send(msg: object): void;
	close(): Promise<void>;
}

function createTestServer(): TestServer {
	const receivedText: unknown[] = [];
	const receivedBinary: ReceivedBinary[] = [];
	let connectedClient: WebSocket | null = null;
	const clientWaiters: Array<(ws: WebSocket) => void> = [];

	const wss = new WebSocketServer({ port: 0 });

	wss.on("connection", (ws: WebSocket) => {
		connectedClient = ws;
		for (const waiter of clientWaiters) waiter(ws);
		clientWaiters.length = 0;

		ws.on("message", (data: Buffer, isBinary: boolean) => {
			if (isBinary) {
				try {
					const decoded = decodeBinaryFrame(data);
					receivedBinary.push({
						header: decoded.header,
						payload: decoded.payload,
					});
				} catch {
					// malformed — ignore
				}
			} else {
				const text =
					data instanceof Buffer ? data.toString("utf8") : String(data);
				try {
					const parsed = JSON.parse(text) as Record<string, unknown>;
					receivedText.push(parsed);

					if (parsed.type === "hello") {
						// Server assigns its own session id for the ready response
						const connId = `srv-${Date.now()}`;
						ws.send(JSON.stringify({ type: "ready", sessionId: connId }));
					} else if (parsed.type === "ping") {
						ws.send(JSON.stringify({ type: "pong" }));
					}
				} catch {
					// ignore parse errors
				}
			}
		});

		ws.on("close", () => {
			if (connectedClient === ws) connectedClient = null;
		});
	});

	const addr = wss.address() as { port: number };

	return {
		wss,
		port: addr.port,
		receivedText,
		receivedBinary,
		waitForClient() {
			return new Promise((resolve) => {
				if (connectedClient) {
					resolve(connectedClient);
				} else {
					clientWaiters.push(resolve);
				}
			});
		},
		send(msg: object) {
			if (connectedClient) {
				connectedClient.send(JSON.stringify(msg));
			}
		},
		close(): Promise<void> {
			return new Promise((resolve) => {
				wss.close(() => resolve());
			});
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsUrl(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

/** Wait until a predicate becomes true, polling every 10 ms, up to timeoutMs. */
function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (pred()) {
				resolve();
			} else if (Date.now() > deadline) {
				reject(new Error("waitUntil: timed out"));
			} else {
				setTimeout(check, 10);
			}
		};
		check();
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DeviceEmulator WebSocket integration", () => {
	let server: TestServer;
	let emulator: DeviceEmulator;

	beforeEach(() => {
		server = createTestServer();
	});

	afterEach(async () => {
		emulator?.disconnect();
		await server.close();
	});

	// ── Handshake tests ──────────────────────────────────────────────────────

	it("connects and completes hello/ready handshake for meta-quest", async () => {
		emulator = new DeviceEmulator("meta-quest");
		await emulator.connect(wsUrl(server.port));

		expect(emulator.connected).toBe(true);
		expect(emulator.getSessionId()).toMatch(/^srv-/);

		const hello = server.receivedText.find(
			(m) => (m as Record<string, unknown>).type === "hello",
		) as Record<string, unknown> | undefined;
		expect(hello).toBeDefined();
		expect(hello?.deviceType).toBe("quest3");
	});

	it("connects and completes hello/ready handshake for simulator", async () => {
		emulator = new DeviceEmulator("simulator");
		await emulator.connect(wsUrl(server.port));

		expect(emulator.connected).toBe(true);
		expect(emulator.getSessionId()).toMatch(/^srv-/);

		const hello = server.receivedText.find(
			(m) => (m as Record<string, unknown>).type === "hello",
		) as Record<string, unknown> | undefined;
		expect(hello).toBeDefined();
		expect(hello?.deviceType).toBe("simulator");
	});

	// ── Binary frame tests ───────────────────────────────────────────────────

	it("sends audio binary frame with correct 4-byte length prefix", async () => {
		emulator = new DeviceEmulator("meta-quest");
		await emulator.connect(wsUrl(server.port));

		const audioData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		emulator.sendAudioChunk(audioData, "webm-opus");

		await waitUntil(() => server.receivedBinary.length > 0);

		const frame = server.receivedBinary[0];
		expect(frame).toBeDefined();
		expect(frame?.header.type).toBe("audio");

		// The header must have the encoding we sent
		const h = frame?.header as {
			type: string;
			encoding: string;
			sampleRate: number;
		};
		expect(h.encoding).toBe("webm-opus");
		expect(h.sampleRate).toBe(16000);

		// Payload must match the original bytes
		expect(Array.from(frame?.payload)).toEqual([0x01, 0x02, 0x03, 0x04]);
	});

	it("sends camera frame with correct framing", async () => {
		emulator = new DeviceEmulator("simulator");
		await emulator.connect(wsUrl(server.port));

		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
		emulator.sendCameraFrame(jpeg, 320, 240);

		await waitUntil(() => server.receivedBinary.length > 0);

		const frame = server.receivedBinary[0];
		expect(frame).toBeDefined();
		expect(frame?.header.type).toBe("frame");

		const h = frame?.header as {
			type: string;
			width: number;
			height: number;
			format: string;
		};
		expect(h.width).toBe(320);
		expect(h.height).toBe(240);
		expect(h.format).toBe("jpeg");

		expect(Array.from(frame?.payload)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
	});

	// ── Control message tests ────────────────────────────────────────────────

	it("ping/pong roundtrip works", async () => {
		emulator = new DeviceEmulator("xreal");
		await emulator.connect(wsUrl(server.port));

		const received: unknown[] = [];
		emulator.onMessage((msg) => received.push(msg));

		emulator.sendControl({ type: "ping" });

		await waitUntil(() =>
			received.some((m) => (m as Record<string, unknown>).type === "pong"),
		);

		const pong = received.find(
			(m) => (m as Record<string, unknown>).type === "pong",
		);
		expect(pong).toBeDefined();
	});

	// ── Disconnect test ──────────────────────────────────────────────────────

	it("disconnect() closes the websocket", async () => {
		emulator = new DeviceEmulator("apple-vision-pro");
		await emulator.connect(wsUrl(server.port));
		expect(emulator.connected).toBe(true);

		emulator.disconnect();

		expect(emulator.connected).toBe(false);
	});

	// ── Device type mapping ──────────────────────────────────────────────────

	it.each<FacewearDeviceType>([
		"meta-quest",
		"xreal",
		"even-realities",
		"apple-vision-pro",
		"simulator",
	])("handshake succeeds for device type %s", async (deviceType) => {
		emulator = new DeviceEmulator(deviceType);
		await emulator.connect(wsUrl(server.port));
		expect(emulator.connected).toBe(true);
		expect(emulator.getSessionId()).toBeTruthy();
	});
});
