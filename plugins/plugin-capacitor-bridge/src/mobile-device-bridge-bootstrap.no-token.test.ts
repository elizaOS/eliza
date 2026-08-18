/**
 * Device-bridge fail-closed contract (W1-011): with ELIZA_DEVICE_BRIDGE_ENABLED=1
 * but NO pairing token configured, attachMobileDeviceBridgeToServer must refuse
 * to attach — an unauthenticated WS client must never be able to register as an
 * inference device and receive routed generation prompts. The singleton reads
 * its env at import time, so the token vars are deleted before the dynamic
 * import below.
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
	ELIZA_DEVICE_BRIDGE_TOKEN: process.env.ELIZA_DEVICE_BRIDGE_TOKEN,
};

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
delete process.env.ELIZA_DEVICE_BRIDGE_TOKEN;

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("mobile device bridge with no pairing token (W1-011)", () => {
	it("refuses to attach, so the bridge stays disabled", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const server = http.createServer((_req, res) => res.end("ok"));
		try {
			await expect(
				bridge.attachMobileDeviceBridgeToServer(server),
			).resolves.toBe(false);
			expect(bridge.mobileDeviceBridge.status().enabled).toBe(false);
			expect(bridge.mobileDeviceBridge.status().connected).toBe(false);
		} finally {
			if (server.listening) await new Promise((r) => server.close(r));
		}
	});
});
