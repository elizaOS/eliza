/**
 * Device-bridge WebSocket authentication contract (W1-011): with no
 * ELIZA_DEVICE_PAIRING_TOKEN configured the bridge must FAIL CLOSED — an
 * unauthenticated client must never register as an inference device (a rogue
 * registration would supersede the real device and receive full generation
 * prompts). Real HTTP server + real `ws` client; only the env is staged.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DeviceBridge } from "./device-bridge";

const ENV_KEYS = [
	"ELIZA_DEVICE_PAIRING_TOKEN",
	"ELIZA_DEVICE_BRIDGE_TOKEN",
] as const;
const savedEnv = new Map<string, string | undefined>();

function saveEnv(): void {
	savedEnv.clear();
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
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

/** Resolves with the close code once the socket closes (or opens then closes). */
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("DeviceBridge WebSocket authentication (W1-011)", () => {
	it("fails closed when no pairing token is configured", async () => {
		saveEnv();
		delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
		delete process.env.ELIZA_DEVICE_BRIDGE_TOKEN;
		const bridge = new DeviceBridge();

		await withBridgeServer(bridge, async (baseUrl) => {
			await expect(connectAndWaitForClose(baseUrl)).resolves.toBe(4001);
		});
	});

	it("rejects a wrong query token when a pairing token is configured", async () => {
		saveEnv();
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = "expected-pairing-token";
		const bridge = new DeviceBridge();

		await withBridgeServer(bridge, async (baseUrl) => {
			await expect(
				connectAndWaitForClose(`${baseUrl}?token=wrong-token`),
			).resolves.toBe(4001);
		});
	});

	it("rejects a register frame with a wrong pairing token", async () => {
		saveEnv();
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = "expected-pairing-token";
		const bridge = new DeviceBridge();

		await withBridgeServer(bridge, async (baseUrl) => {
			const socket = new WebSocket(`${baseUrl}?token=expected-pairing-token`);
			try {
				await new Promise<void>((resolve, reject) => {
					socket.once("open", resolve);
					socket.once("error", reject);
				});
				const closed = new Promise<number>((resolve) =>
					socket.once("close", resolve),
				);
				socket.send(
					JSON.stringify({
						type: "register",
						payload: {
							deviceId: "rogue-device",
							pairingToken: "wrong-token",
							capabilities: {
								platform: "android",
								deviceModel: "auth-test",
								totalRamGb: 8,
								cpuCores: 8,
								gpu: null,
							},
							loadedPath: null,
						},
					}),
				);
				await expect(closed).resolves.toBe(4001);
				expect(bridge.status().connected).toBe(false);
			} finally {
				socket.terminate();
			}
		});
	});

	it("registers a device that presents the configured token", async () => {
		saveEnv();
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = "expected-pairing-token";
		const bridge = new DeviceBridge();

		await withBridgeServer(bridge, async (baseUrl) => {
			const socket = new WebSocket(`${baseUrl}?token=expected-pairing-token`);
			try {
				await new Promise<void>((resolve, reject) => {
					socket.once("open", resolve);
					socket.once("error", reject);
				});
				socket.send(
					JSON.stringify({
						type: "register",
						payload: {
							deviceId: "legit-device",
							pairingToken: "expected-pairing-token",
							capabilities: {
								platform: "android",
								deviceModel: "auth-test",
								totalRamGb: 8,
								cpuCores: 8,
								gpu: null,
							},
							loadedPath: null,
						},
					}),
				);
				const deadline = Date.now() + 3_000;
				while (!bridge.status().connected) {
					if (Date.now() >= deadline) {
						throw new Error("device did not register in time");
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(bridge.status().devices[0]?.deviceId).toBe("legit-device");
			} finally {
				socket.terminate();
			}
		});
	});
});
