/**
 * Exercises the real HTTP upgrade boundary so snapshot draining cannot be
 * bypassed by the separately attached Capacitor device-bridge listener.
 */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const servers = new Set<http.Server>();
const originalBridgeEnabled = process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
const originalPairingToken = process.env.ELIZA_DEVICE_PAIRING_TOKEN;

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		"Timed out waiting for the device bridge to release admission",
	);
}

afterEach(async () => {
	if (originalBridgeEnabled === undefined) {
		delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
	} else {
		process.env.ELIZA_DEVICE_BRIDGE_ENABLED = originalBridgeEnabled;
	}
	if (originalPairingToken === undefined) {
		delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
	} else {
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = originalPairingToken;
	}
	await Promise.all(
		[...servers].map(
			(server) =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		),
	);
	servers.clear();
	vi.resetModules();
});

describe("mobile device bridge snapshot admission", () => {
	it("returns 503 when snapshot draining rejects a bridge upgrade", async () => {
		process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = "snapshot-test-token";
		vi.resetModules();
		const { attachMobileDeviceBridgeToServer } = await import(
			"./mobile-device-bridge-bootstrap.ts"
		);
		const server = http.createServer((_req, res) => {
			res.statusCode = 404;
			res.end();
		});
		servers.add(server);
		await attachMobileDeviceBridgeToServer(server, {
			admitUpgrade: () => {
				throw new Error("snapshot draining");
			},
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Device bridge test server did not bind");
		}

		const status = await new Promise<number>((resolve, reject) => {
			const client = new WebSocket(
				`ws://127.0.0.1:${address.port}/api/local-inference/device-bridge?token=snapshot-test-token`,
			);
			client.once("unexpected-response", (_request, response) => {
				resolve(response.statusCode);
				response.resume();
			});
			client.once("open", () =>
				reject(new Error("Upgrade unexpectedly opened")),
			);
			client.once("error", (error) => {
				if (!error.message.includes("Unexpected server response: 503")) {
					reject(error);
				}
			});
		});

		expect(status).toBe(503);
	});

	it("holds admission for the connection and reports the bridge as non-quiescent", async () => {
		process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
		process.env.ELIZA_DEVICE_PAIRING_TOKEN = "snapshot-test-token";
		vi.resetModules();
		const {
			assertMobileDeviceBridgeSnapshotQuiescent,
			attachMobileDeviceBridgeToServer,
		} = await import("./mobile-device-bridge-bootstrap.ts");
		const release = vi.fn();
		const server = http.createServer((_req, res) => {
			res.statusCode = 404;
			res.end();
		});
		servers.add(server);
		await attachMobileDeviceBridgeToServer(server, {
			admitUpgrade: () => ({ release }),
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Device bridge test server did not bind");
		}
		const client = new WebSocket(
			`ws://127.0.0.1:${address.port}/api/local-inference/device-bridge?token=snapshot-test-token`,
		);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		expect(() => assertMobileDeviceBridgeSnapshotQuiescent()).toThrow(
			"must disconnect",
		);
		const closed = new Promise<void>((resolve) =>
			client.once("close", () => resolve()),
		);
		client.close();
		await closed;
		await waitUntil(() => release.mock.calls.length === 1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(() => assertMobileDeviceBridgeSnapshotQuiescent()).not.toThrow();
	});
});
