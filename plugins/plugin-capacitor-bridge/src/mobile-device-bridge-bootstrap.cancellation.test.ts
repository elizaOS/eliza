/**
 * Exercises caller cancellation and disconnect cleanup over the real WebSocket
 * bridge transport; no model or socket layer is replaced with a mock.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const TOKEN = "device-bridge-cancellation-test";
const savedEnabled = process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
const savedToken = process.env.ELIZA_DEVICE_PAIRING_TOKEN;

interface BridgeHarness {
	bridge: {
		attachToHttpServer(server: http.Server): Promise<void>;
		generate(args: { prompt: string; signal?: AbortSignal }): Promise<string>;
		status(): { pendingRequests: number };
		onDeviceAttached(listener: () => void): void;
	};
	server: http.Server;
	client: WebSocket;
	messages: Array<Record<string, unknown>>;
	nextMessage(type: string): Promise<Record<string, unknown>>;
}

async function closeServer(server: http.Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

async function openHarness(): Promise<BridgeHarness> {
	process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
	process.env.ELIZA_DEVICE_PAIRING_TOKEN = TOKEN;
	const { MobileDeviceBridge } = await import(
		"./mobile-device-bridge-bootstrap"
	);
	const bridge = new MobileDeviceBridge();
	const server = http.createServer();
	await bridge.attachToHttpServer(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	const client = new WebSocket(
		`ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=${TOKEN}`,
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

	const attached = new Promise<void>((resolve) => {
		bridge.onDeviceAttached(resolve);
	});
	client.send(
		JSON.stringify({
			type: "register",
			payload: {
				deviceId: "android-test-device",
				pairingToken: TOKEN,
				capabilities: {
					platform: "android",
					deviceModel: "test",
					totalRamGb: 8,
					cpuCores: 8,
					gpu: { backend: "vulkan", available: true },
				},
				loadedPath: "/models/eliza.gguf",
			},
		}),
	);
	await attached;
	return { bridge, server, client, messages, nextMessage };
}

async function closeHarness(harness: BridgeHarness): Promise<void> {
	if (
		harness.client.readyState === WebSocket.OPEN ||
		harness.client.readyState === WebSocket.CONNECTING
	) {
		harness.client.close();
		await new Promise<void>((resolve) =>
			harness.client.once("close", () => resolve()),
		);
	}
	await closeServer(harness.server);
}

describe("MobileDeviceBridge cancellation", () => {
	beforeEach(() => {
		process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = TOKEN;
	});

	afterEach(() => {
		if (savedEnabled === undefined) {
			delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
		} else {
			process.env.ELIZA_DEVICE_BRIDGE_ENABLED = savedEnabled;
		}
		if (savedToken === undefined) {
			delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
		} else {
			process.env.ELIZA_DEVICE_PAIRING_TOKEN = savedToken;
		}
	});

	it("sends a native cancel frame and removes the pending request on abort", async () => {
		const harness = await openHarness();
		try {
			const controller = new AbortController();
			const generation = harness.bridge.generate({
				prompt: "keep decoding",
				signal: controller.signal,
			});
			const request = await harness.nextMessage("generate");
			controller.abort();

			await expect(generation).rejects.toMatchObject({ name: "AbortError" });
			const cancel = await harness.nextMessage("cancel");
			expect(cancel.correlationId).toBe(request.correlationId);
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});

	it("rejects immediately when the serving device disconnects", async () => {
		const harness = await openHarness();
		try {
			const generation = harness.bridge.generate({
				prompt: "disconnect during decode",
			});
			await harness.nextMessage("generate");
			harness.client.close();

			await expect(generation).rejects.toThrow(
				/DEVICE_DISCONNECTED: android-test-device during generation/,
			);
			expect(harness.bridge.status().pendingRequests).toBe(0);
		} finally {
			await closeHarness(harness);
		}
	});

	it("closes an invalid result frame and rejects its pending generation", async () => {
		const harness = await openHarness();
		try {
			const generation = harness.bridge.generate({
				prompt: "validate the native result envelope",
			});
			const rejected = expect(generation).rejects.toThrow(
				/DEVICE_DISCONNECTED: android-test-device during generation/,
			);
			const request = await harness.nextMessage("generate");
			const closed = new Promise<number>((resolve) => {
				harness.client.once("close", resolve);
			});
			harness.client.send(
				JSON.stringify({
					type: "generateResult",
					correlationId: request.correlationId,
					ok: true,
					text: "missing required telemetry",
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
