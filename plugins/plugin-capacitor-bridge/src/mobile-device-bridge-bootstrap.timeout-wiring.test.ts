/**
 * Proves a valid, non-default ELIZA_DEVICE_GENERATE_TIMEOUT_MS actually
 * reaches the real setTimeout call inside sendToPrimary() - not just that
 * the standalone parser resolves it correctly in isolation. Boots the
 * canonical device bridge through a real HTTP server and a real WebSocket
 * device connection (same harness as mobile-device-bridge-headless-boot.test.ts),
 * spies on the global setTimeout, and asserts the delay used for a live
 * generate() call equals the configured value, not the 600s default.
 */
import http from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
	ELIZA_DEVICE_GENERATE_TIMEOUT_MS:
		process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS,
};

const pairingToken = "timeout-wiring-pairing-token";
// Deliberately not the 600_000 default and not a round number, so this test
// cannot pass by coincidentally matching the fallback.
const CONFIGURED_GENERATE_TIMEOUT_MS = 47_531;

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = pairingToken;
process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = String(
	CONFIGURED_GENERATE_TIMEOUT_MS,
);

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
				reject(new Error("Timeout-wiring server did not expose a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

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

describe("mobile device bridge activation-time timeout wiring", () => {
	it("uses the exact configured ELIZA_DEVICE_GENERATE_TIMEOUT_MS for a live generate() call", async () => {
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
			socket.send(
				JSON.stringify({
					type: "register",
					payload: {
						deviceId: "timeout-wiring-device",
						pairingToken,
						capabilities: {
							platform: "android",
							deviceModel: "timeout-wiring-test",
							totalRamGb: 8,
							cpuCores: 8,
							gpu: { backend: "vulkan", available: true },
						},
						loadedPath: null,
					},
				}),
			);
			await waitFor(
				() => bridge.mobileDeviceBridge.status().connected,
				"device registration",
			);

			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
			// Never resolved by the fake device - this call exists only to reach
			// the setTimeout(..., timeoutMs) call inside sendToPrimary().
			void bridge.mobileDeviceBridge
				.generate({ prompt: "wiring probe" })
				.catch(() => {});

			await waitFor(
				() => bridge.mobileDeviceBridge.status().pendingRequests === 1,
				"pending generate RPC",
			);

			const generateTimeoutCall = setTimeoutSpy.mock.calls.find(
				(call) => call[1] === CONFIGURED_GENERATE_TIMEOUT_MS,
			);
			expect(generateTimeoutCall).toBeDefined();
			// Mutation-resistant: also confirm the default was NOT what fired -
			// catches a mutation that ignores the configured value entirely.
			expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 600_000)).toBe(
				false,
			);

			setTimeoutSpy.mockRestore();
		} finally {
			if (socket?.readyState === WebSocket.OPEN) socket.close();
			if (server.listening) await new Promise((r) => server.close(r));
		}
	});
});
