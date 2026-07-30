/**
 * Exercises cancellation, disconnect failure, and live-device rerouting over
 * real WebSocket connections against the production bridge implementation.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceBridge } from "./device-bridge";

const TOKEN = "local-inference-device-bridge-test";
const savedToken = process.env.ELIZA_DEVICE_PAIRING_TOKEN;

interface ConnectedTestDevice {
	client: WebSocket;
	messages: Array<Record<string, unknown>>;
	nextMessage(type: string): Promise<Record<string, unknown>>;
}

interface BridgeHarness {
	bridge: DeviceBridge;
	server: http.Server;
	port: number;
	devices: ConnectedTestDevice[];
}

async function openHarness(): Promise<BridgeHarness> {
	const bridge = new DeviceBridge();
	const server = http.createServer();
	await bridge.attachToHttpServer(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		bridge,
		server,
		port: (server.address() as AddressInfo).port,
		devices: [],
	};
}

async function connectDevice(
	harness: BridgeHarness,
	deviceId: string,
	totalRamGb: number,
): Promise<ConnectedTestDevice> {
	const client = new WebSocket(
		`ws://127.0.0.1:${harness.port}/api/local-inference/device-bridge?token=${TOKEN}`,
	);
	await new Promise<void>((resolve, reject) => {
		client.once("open", resolve);
		client.once("error", reject);
	});
	const messages: Array<Record<string, unknown>> = [];
	const waiters = new Map<
		string,
		Array<(message: Record<string, unknown>) => void>
	>();
	client.on("message", (raw) => {
		const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		messages.push(message);
		waiters.get(String(message.type))?.shift()?.(message);
	});
	const nextMessage = (type: string) => {
		const existing = messages.find((message) => message.type === type);
		if (existing) return Promise.resolve(existing);
		return new Promise<Record<string, unknown>>((resolve) => {
			const queue = waiters.get(type) ?? [];
			queue.push(resolve);
			waiters.set(type, queue);
		});
	};
	const registered = new Promise<void>((resolve) => {
		const unsubscribe = harness.bridge.subscribeStatus((status) => {
			if (!status.devices.some((device) => device.deviceId === deviceId))
				return;
			unsubscribe();
			resolve();
		});
	});
	client.send(
		JSON.stringify({
			type: "register",
			payload: {
				deviceId,
				pairingToken: TOKEN,
				capabilities: {
					platform: "android",
					deviceModel: deviceId,
					totalRamGb,
					cpuCores: 8,
					gpu: { backend: "vulkan", available: true },
				},
				loadedPath: "/models/eliza.gguf",
			},
		}),
	);
	await registered;
	const device = { client, messages, nextMessage };
	harness.devices.push(device);
	return device;
}

async function closeHarness(harness: BridgeHarness): Promise<void> {
	for (const device of harness.devices) {
		if (
			device.client.readyState === WebSocket.OPEN ||
			device.client.readyState === WebSocket.CONNECTING
		) {
			await new Promise<void>((resolve) => {
				device.client.once("close", resolve);
				device.client.close();
			});
		}
	}
	await new Promise<void>((resolve, reject) => {
		harness.server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("DeviceBridge owner lifecycle", () => {
	beforeEach(() => {
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = TOKEN;
	});

	afterEach(() => {
		if (savedToken === undefined) {
			delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
		} else {
			process.env.ELIZA_DEVICE_PAIRING_TOKEN = savedToken;
		}
	});

	it("sends correlated cancellation and removes the abandoned request", async () => {
		const harness = await openHarness();
		try {
			const device = await connectDevice(harness, "android-a", 8);
			const controller = new AbortController();
			const generation = harness.bridge.generate({
				prompt: "cancel this",
				signal: controller.signal,
			});
			const request = await device.nextMessage("generate");
			controller.abort();

			await expect(generation).rejects.toMatchObject({ name: "AbortError" });
			const cancel = await device.nextMessage("cancel");
			expect(cancel.correlationId).toBe(request.correlationId);
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});

	it("reroutes an in-flight generation only to an already-connected device", async () => {
		const harness = await openHarness();
		try {
			const primary = await connectDevice(harness, "android-primary", 32);
			const replacement = await connectDevice(
				harness,
				"android-replacement",
				8,
			);
			const generation = harness.bridge.generate({ prompt: "reroute this" });
			const original = await primary.nextMessage("generate");
			await new Promise<void>((resolve) => {
				primary.client.once("close", resolve);
				primary.client.close();
			});

			const rerouted = await replacement.nextMessage("generate");
			expect(rerouted.correlationId).toBe(original.correlationId);
			replacement.client.send(
				JSON.stringify({
					type: "generateResult",
					correlationId: rerouted.correlationId,
					ok: true,
					text: "replacement result",
					promptTokens: 3,
					outputTokens: 2,
					durationMs: 10,
				}),
			);

			await expect(generation).resolves.toBe("replacement result");
			expect(harness.bridge.latestGenerationMetrics()?.deviceId).toBe(
				"android-replacement",
			);
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});

	it("fails immediately when a disconnected owner has no live replacement", async () => {
		const harness = await openHarness();
		try {
			const device = await connectDevice(harness, "android-only", 8);
			const generation = harness.bridge.generate({ prompt: "disconnect" });
			await device.nextMessage("generate");
			const closed = new Promise<void>((resolve) =>
				device.client.once("close", resolve),
			);
			device.client.close();

			await expect(generation).rejects.toThrow(
				/DEVICE_DISCONNECTED: android-only during generation/,
			);
			await closed;
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});

	it("rejects malformed successful telemetry instead of fabricating a result", async () => {
		const harness = await openHarness();
		try {
			const device = await connectDevice(harness, "android-invalid", 8);
			const generation = harness.bridge.generate({
				prompt: "validate telemetry",
			});
			const rejected = expect(generation).rejects.toThrow(
				/DEVICE_DISCONNECTED: android-invalid during generation/,
			);
			const request = await device.nextMessage("generate");
			const closed = new Promise<number>((resolve) =>
				device.client.once("close", resolve),
			);
			device.client.send(
				JSON.stringify({
					type: "generateResult",
					correlationId: request.correlationId,
					ok: true,
					text: "missing counters",
				}),
			);

			await expect(closed).resolves.toBe(4004);
			await rejected;
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});
});
