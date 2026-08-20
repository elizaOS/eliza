/**
 * Boots the canonical device bridge through a real AgentRuntime and HTTP/WebSocket
 * transport, proving attach-gated handlers and server-owned teardown.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, ModelType, ServiceType } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
	ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD:
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD,
	ELIZA_LOCAL_CHAT_MODEL_PATH: process.env.ELIZA_LOCAL_CHAT_MODEL_PATH,
	ELIZA_LOCAL_LLAMA: process.env.ELIZA_LOCAL_LLAMA,
};

const pairingToken = "headless-bridge-pairing-token";
const stateDir = mkdtempSync(path.join(os.tmpdir(), "device-bridge-boot-"));
const modelPath = path.join(stateDir, "headless-chat.gguf");
writeFileSync(modelPath, "deterministic headless bridge fixture");
process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = pairingToken;
process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
process.env.ELIZA_LOCAL_CHAT_MODEL_PATH = modelPath;
delete process.env.ELIZA_LOCAL_LLAMA;

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Headless bridge server did not expose a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("canonical mobile device bridge headless boot", () => {
	it("waits for attach, serves through one handler, and lets the server tear transport down", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const runtime = new AgentRuntime({
			logLevel: "fatal",
			plugins: [bridge.mobileDeviceBridgePlugin],
		});
		const server = http.createServer((_req, res) => res.end("ok"));
		let socket: WebSocket | null = null;

		try {
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(runtime),
			).resolves.toBe(false);
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(runtime),
			).resolves.toBe(false);
			expect(runtime.hasService(ServiceType.MOBILE_DEVICE_BRIDGE)).toBe(true);
			expect(
				runtime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "capacitor-llama"),
			).toHaveLength(0);

			await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
			const service = await runtime.getServiceLoadPromise(
				ServiceType.MOBILE_DEVICE_BRIDGE,
			);
			expect(service).toBeInstanceOf(bridge.CapacitorMobileDeviceBridgeService);
			expect(
				runtime.getServicesByType(ServiceType.MOBILE_DEVICE_BRIDGE),
			).toHaveLength(1);
			expect(
				runtime.plugins.filter(
					(plugin) => plugin.name === bridge.mobileDeviceBridgePlugin.name,
				),
			).toHaveLength(1);

			await expect(
				Promise.all([
					bridge.attachMobileDeviceBridgeToServer(server),
					bridge.attachMobileDeviceBridgeToServer(server),
				]),
			).resolves.toEqual([true, true]);
			expect(server.listenerCount("upgrade")).toBe(1);
			const port = await listen(server);
			socket = new WebSocket(
				`ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=${pairingToken}`,
			);
			await new Promise<void>((resolve, reject) => {
				socket?.once("open", resolve);
				socket?.once("error", reject);
			});

			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as {
					type: string;
					correlationId?: string;
					prompt?: string;
				};
				if (message.type === "generate" && message.prompt !== "pending") {
					socket?.send(
						JSON.stringify({
							type: "generateResult",
							correlationId: message.correlationId,
							ok: true,
							text: "headless-device-reply",
							promptTokens: 2,
							outputTokens: 3,
							durationMs: 5,
						}),
					);
				}
			});
			socket.send(
				JSON.stringify({
					type: "register",
					payload: {
						deviceId: "headless-device",
						pairingToken,
						capabilities: {
							platform: "android",
							deviceModel: "headless-test",
							totalRamGb: 8,
							cpuCores: 8,
							gpu: { backend: "vulkan", available: true },
						},
						loadedPath: modelPath,
					},
				}),
			);

			await waitFor(
				() => bridge.mobileDeviceBridge.status().connected,
				"device registration",
			);
			await waitFor(
				() =>
					runtime
						.getModelRegistrations()
						.some(
							(entry) =>
								entry.modelType === ModelType.TEXT_SMALL &&
								entry.provider === "capacitor-llama",
						),
				"attach-gated model registration",
			);
			const textRegistrations = runtime
				.getModelRegistrations()
				.filter(
					(entry) =>
						entry.modelType === ModelType.TEXT_SMALL &&
						entry.provider === "capacitor-llama",
				);
			expect(textRegistrations).toHaveLength(1);

			const registeredHandler = runtime.models
				.get(ModelType.TEXT_SMALL)
				?.find((entry) => entry.provider === "capacitor-llama")?.handler;
			if (!registeredHandler)
				throw new Error("Bridge TEXT_SMALL handler missing");
			await expect(
				registeredHandler(runtime, { prompt: "headless request" }),
			).resolves.toBe("headless-device-reply");

			const pending = bridge.mobileDeviceBridge.generate({ prompt: "pending" });
			await waitFor(
				() => bridge.mobileDeviceBridge.status().pendingRequests === 1,
				"pending device RPC",
			);
			const pendingStopped = expect(pending).rejects.toThrow(
				"DEVICE_BRIDGE_STOPPED",
			);
			const clientClosed = new Promise<void>((resolve) =>
				socket?.once("close", () => resolve()),
			);
			await runtime.stop();
			expect(server.listenerCount("upgrade")).toBe(1);
			expect(bridge.mobileDeviceBridge.status().pendingRequests).toBe(1);

			// The HTTP server owns the process-global transport. Runtime replacement
			// must not tear it away from the incoming runtime, while the server close
			// boundary still releases every transport resource.
			server.emit("close");
			await pendingStopped;
			await clientClosed;
			expect(bridge.mobileDeviceBridge.status().connected).toBe(false);
			expect(bridge.mobileDeviceBridge.status().pendingRequests).toBe(0);
			expect(server.listenerCount("upgrade")).toBe(0);
		} finally {
			if (socket?.readyState === WebSocket.OPEN) socket.close();
			await runtime.stop({ fast: true });
			if (server.listening) await closeServer(server);
		}
	});
});
