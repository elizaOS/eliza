/**
 * Device-bridge pairing-token enforcement on the canonical wired bridge
 * (W1-011): a wrong `?token=` query value and a wrong register-frame pairing
 * token are both closed with 4001. Real HTTP server + real `ws` client; the
 * singleton reads its env at import time, so the token is staged before the
 * dynamic import below.
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
};

const pairingToken = "auth-test-pairing-token";

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = pairingToken;

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

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

function connectAndWaitForClose(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error("timed out waiting for the bridge to close the socket"));
		}, 5_000);
		socket.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function registerFrame(token: string): string {
	return JSON.stringify({
		type: "register",
		payload: {
			deviceId: "auth-test-device",
			pairingToken: token,
			capabilities: {
				platform: "android",
				deviceModel: "auth-test",
				totalRamGb: 8,
				cpuCores: 8,
				gpu: { backend: "vulkan", available: true },
			},
			loadedPath: null,
		},
	});
}

describe("mobile device bridge pairing-token enforcement (W1-011)", () => {
	it("closes a wrong query token with 4001", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const server = http.createServer((_req, res) => res.end("ok"));
		try {
			await bridge.attachMobileDeviceBridgeToServer(server);
			const port = await listen(server);
			await expect(
				connectAndWaitForClose(
					`ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=wrong-token`,
				),
			).resolves.toBe(4001);
			expect(bridge.mobileDeviceBridge.status().connected).toBe(false);
		} finally {
			await bridge.mobileDeviceBridge.close();
			if (server.listening) await new Promise((r) => server.close(r));
		}
	});

	it("closes a register frame with a wrong pairing token with 4001", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const server = http.createServer((_req, res) => res.end("ok"));
		let socket: WebSocket | null = null;
		try {
			await bridge.attachMobileDeviceBridgeToServer(server);
			const port = await listen(server);
			socket = new WebSocket(
				`ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=${pairingToken}`,
			);
			await new Promise<void>((resolve, reject) => {
				socket?.once("open", resolve);
				socket?.once("error", reject);
			});
			const closed = new Promise<number>((resolve) =>
				socket?.once("close", resolve),
			);
			socket.send(registerFrame("wrong-token"));
			await expect(closed).resolves.toBe(4001);
			expect(bridge.mobileDeviceBridge.status().connected).toBe(false);
		} finally {
			if (socket?.readyState === WebSocket.OPEN) socket.close();
			await bridge.mobileDeviceBridge.close();
			if (server.listening) await new Promise((r) => server.close(r));
		}
	});
});
