/**
 * Heartbeat liveness contract for the local-inference device bridge.
 *
 * The bridge pings a registered device every interval. A peer that stops
 * answering (asleep phone, dead Wi-Fi link that never closes the TCP socket)
 * keeps its routing slot because nothing counts the missing replies, so every
 * generate keeps routing to it and waits for the call deadline. Three silent
 * intervals must evict the device and re-route its in-flight request.
 *
 * Real HTTP server, real `ws` clients; only the env is staged.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DeviceBridge } from "./device-bridge";

const HEARTBEAT_INTERVAL_MS = 40;
const GENERATE_TIMEOUT_MS = 1_500;
const ENV_KEYS = [
	"ELIZA_DEVICE_PAIRING_TOKEN",
	"ELIZA_DEVICE_GENERATE_TIMEOUT_MS",
	"ELIZA_DEVICE_HEARTBEAT_INTERVAL_MS",
	"ELIZA_STATE_DIR",
] as const;
const savedEnv = new Map<string, string | undefined>();
const openSockets: WebSocket[] = [];
let stateDir: string;

beforeEach(async () => {
	savedEnv.clear();
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
	stateDir = await mkdtemp(path.join(tmpdir(), "device-bridge-heartbeat-"));
	process.env.ELIZA_STATE_DIR = stateDir;
	process.env.ELIZA_DEVICE_PAIRING_TOKEN = "test-pairing-token";
	process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = String(GENERATE_TIMEOUT_MS);
	process.env.ELIZA_DEVICE_HEARTBEAT_INTERVAL_MS = String(
		HEARTBEAT_INTERVAL_MS,
	);
});

afterEach(async () => {
	for (const socket of openSockets.splice(0)) socket.terminate();
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(stateDir, { recursive: true, force: true });
});

function capabilities(platform: "ios" | "desktop", totalRamGb: number) {
	return {
		platform,
		deviceModel: platform === "ios" ? "iPhone17,2" : "test-desktop",
		totalRamGb,
		cpuCores: 8,
		gpu: null,
	};
}

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("test server did not expose a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error(`condition not met within ${timeoutMs}ms`));
				return;
			}
			setTimeout(tick, 5);
		};
		tick();
	});
}

interface DeviceOptions {
	deviceId: string;
	capabilities: ReturnType<typeof capabilities>;
	/** A healthy peer answers every ping; a silent peer answers nothing. */
	answerPings: boolean;
	replyWith?: string;
}

/** Registers one device and records whether the bridge terminated it. */
function connectDevice(url: string, options: DeviceOptions) {
	const socket = new WebSocket(url);
	openSockets.push(socket);
	const closed = new Promise<void>((resolve) => {
		socket.once("close", () => resolve());
	});
	socket.on("open", () => {
		socket.send(
			JSON.stringify({
				type: "register",
				payload: {
					deviceId: options.deviceId,
					pairingToken: "test-pairing-token",
					capabilities: options.capabilities,
					loadedPath: "/models/test.gguf",
				},
			}),
		);
	});
	socket.on("message", (raw) => {
		const msg = JSON.parse(raw.toString("utf8")) as {
			type: string;
			correlationId?: string;
			at?: number;
		};
		if (msg.type === "ping") {
			if (options.answerPings)
				socket.send(JSON.stringify({ type: "pong", at: msg.at }));
			return;
		}
		if (msg.type === "generate" && options.replyWith) {
			socket.send(
				JSON.stringify({
					type: "generateResult",
					correlationId: msg.correlationId,
					ok: true,
					text: options.replyWith,
					promptTokens: 4,
					outputTokens: 3,
					durationMs: 1,
				}),
			);
		}
	});
	return { socket, closed };
}

async function withBridgeServer(
	bridge: DeviceBridge,
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server = http.createServer((_req, res) => res.end("ok"));
	try {
		await bridge.attachToHttpServer(server);
		const port = await listen(server);
		await run(`ws://127.0.0.1:${port}/api/local-inference/device-bridge`);
	} finally {
		// Upgraded sockets keep the listener alive; drop them before closing.
		for (const socket of openSockets.splice(0)) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("DeviceBridge heartbeat liveness", () => {
	it("evicts a silent device and re-routes its in-flight request", async () => {
		const bridge = new DeviceBridge();
		await withBridgeServer(bridge, async (baseUrl) => {
			const url = `${baseUrl}?token=test-pairing-token`;
			const ghost = connectDevice(url, {
				deviceId: "ghost",
				capabilities: capabilities("desktop", 64),
				answerPings: false,
			});
			const healthy = connectDevice(url, {
				deviceId: "healthy",
				capabilities: capabilities("ios", 8),
				answerPings: true,
				replyWith: "hello from healthy",
			});
			await waitFor(() => bridge.status().devices.length === 2, 2_000);
			// The silent desktop has the higher score, so the request starts there.
			expect(bridge.status().primaryDeviceId).toBe("ghost");

			const started = Date.now();
			const text = await bridge.generate({ prompt: "hello" });
			const elapsedMs = Date.now() - started;

			expect(text).toBe("hello from healthy");
			expect(elapsedMs).toBeLessThan(GENERATE_TIMEOUT_MS / 2);
			expect(bridge.status().devices.map((device) => device.deviceId)).toEqual([
				"healthy",
			]);
			await ghost.closed;
			expect(ghost.socket.readyState).toBe(WebSocket.CLOSED);
			expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
		});
	});
});
