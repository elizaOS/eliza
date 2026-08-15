/**
 * Proves malformed device-bridge timeout configuration fails at the real
 * activation boundary (attachToHttpServer), before any transport or device
 * state is created - not on the first live RPC, which was the pre-fix
 * behavior for the three device settings (the two bionic settings failed
 * even earlier, at module import, regardless of whether the bridge was even
 * enabled).
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
	ELIZA_DEVICE_GENERATE_TIMEOUT_MS:
		process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS,
};

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = "timeout-validation-token";
// Would have been silently accepted (parseInt-style truncation) before this
// fix; now must be rejected before any device can ever connect.
process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = "1e3";

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("mobile device bridge activation-time timeout validation", () => {
	it("rejects attach before creating any transport or device state when a device timeout is malformed", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const server = http.createServer((_req, res) => res.end("ok"));

		await expect(
			bridge.attachMobileDeviceBridgeToServer(server),
		).rejects.toMatchObject({
			code: "INVALID_DEVICE_BRIDGE_TIMEOUT",
			context: expect.objectContaining({
				envKey: "ELIZA_DEVICE_GENERATE_TIMEOUT_MS",
				configured: "1e3",
			}),
		});

		// Mutation-resistant: proves validation ran before any side effect,
		// not merely that it threw somewhere. If validation moved back to
		// inside an individual RPC method (the pre-fix boundary), attach
		// itself would succeed and this would fail.
		expect(server.listenerCount("close")).toBe(0);
		expect(bridge.mobileDeviceBridge.status().connected).toBe(false);
	});
});
