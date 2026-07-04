/**
 * Serving-status coverage for the mobile bionic host path.
 *
 * `getMobileDeviceBridgeServingStatus` reports the host as serving only after
 * handler registration and a live abstract-UDS probe, which is the readiness
 * signal consumed by smoke tests and local-inference provider status.
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SERVICE_ENABLED is read at module load, so enable the bridge before importing.
process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";

const ENV_KEYS = [
	"ELIZA_LOCAL_LLAMA",
	"ELIZA_BIONIC_HOST_DELEGATED",
	"ELIZA_BIONIC_INFERENCE_SOCK",
	"ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD",
];
const saved: Record<string, string | undefined> = {};

function fakeRuntime() {
	return {
		registerModel: vi.fn(),
		getModel: vi.fn(() => undefined),
	};
}

/** Fresh module instance so registeredModelTrigger starts null per test. */
async function freshBootstrap() {
	vi.resetModules();
	process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
	return import("./mobile-device-bridge-bootstrap");
}

/** Listen on the Linux abstract-namespace UDS the bionic host would own. */
function listenOnAbstractSocket(name: string): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => socket.destroy());
		server.on("error", reject);
		server.listen({ path: `\0${name}` }, () => resolve(server));
	});
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("getMobileDeviceBridgeServingStatus — true bionic serving signal (#11498)", () => {
	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		// Registration pre-warms model downloads; keep the unit test offline.
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("reports nothing serving before any handler registration", async () => {
		const mod = await freshBootstrap();
		const status = await mod.getMobileDeviceBridgeServingStatus();
		expect(status).toEqual({
			registeredTrigger: null,
			bionicHostServing: false,
		});
	});

	it("bionic env set + live socket but handlers NOT registered is NOT serving", async () => {
		process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
		process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-unreg";
		const server = await listenOnAbstractSocket("eliza-test-serving-unreg");
		try {
			const mod = await freshBootstrap();
			const status = await mod.getMobileDeviceBridgeServingStatus();
			expect(status.registeredTrigger).toBeNull();
			expect(status.bionicHostServing).toBe(false);
		} finally {
			await closeServer(server);
		}
	});

	it("handlers bound via bionic-host AND a live host socket IS serving", async () => {
		process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
		process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-live";
		const server = await listenOnAbstractSocket("eliza-test-serving-live");
		try {
			const mod = await freshBootstrap();
			const runtime = fakeRuntime();
			await expect(
				mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
			).resolves.toBe(true);
			const status = await mod.getMobileDeviceBridgeServingStatus();
			expect(status).toEqual({
				registeredTrigger: "bionic-host",
				bionicHostServing: true,
			});
		} finally {
			await closeServer(server);
		}
	});

	it("handlers bound via bionic-host but the host socket is DOWN is NOT serving", async () => {
		process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
		process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-dead";
		// Nothing listens on the socket: the probe must fail, not larp readiness.
		const mod = await freshBootstrap();
		const runtime = fakeRuntime();
		await expect(
			mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
		).resolves.toBe(true);
		const status = await mod.getMobileDeviceBridgeServingStatus();
		expect(status.registeredTrigger).toBe("bionic-host");
		expect(status.bionicHostServing).toBe(false);
	});
});
