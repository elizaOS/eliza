/**
 * Regression coverage for dead mobile bridge handler registration.
 *
 * Android text handlers must stay unregistered unless the bionic host or a real
 * device bridge can serve them, otherwise they capture model routing and every
 * chat turn fails with a disconnected-device error.
 */

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
	const runtime = {
		hasService: vi.fn(() => false),
		registerModel: vi.fn(),
		registerService: vi.fn(async () => undefined),
		registerPlugin: vi.fn(async (plugin: { services?: unknown[] }) => {
			for (const service of plugin.services ?? []) {
				await runtime.registerService(service);
			}
		}),
		getModel: vi.fn(() => undefined),
	};
	return runtime;
}

describe("ensureMobileDeviceBridgeInferenceHandlers — dead-bridge gating (#11277)", () => {
	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("does NOT register TEXT handlers when neither the bionic host nor a device bridge can serve", async () => {
		const { ensureMobileDeviceBridgeInferenceHandlers, mobileDeviceBridge } =
			await import("./mobile-device-bridge-bootstrap");
		// No server attached → no device connected.
		expect(mobileDeviceBridge.status().connected).toBe(false);

		const runtime = fakeRuntime();
		const registered = await ensureMobileDeviceBridgeInferenceHandlers(
			runtime as never,
		);

		expect(registered).toBe(false);
		// The critical assertion: the dead provider must not capture the slots.
		expect(runtime.registerModel).not.toHaveBeenCalled();
	});

	it("registers immediately when the in-process bionic host is delegated (it can serve)", async () => {
		process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
		process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-inference-sock";
		const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
			"./mobile-device-bridge-bootstrap"
		);

		const runtime = fakeRuntime();
		const registered = await ensureMobileDeviceBridgeInferenceHandlers(
			runtime as never,
		);

		expect(registered).toBe(true);
		// TEXT_SMALL + TEXT_LARGE at minimum register through the served path.
		expect(runtime.registerModel).toHaveBeenCalled();
	});

	it("exports progressive and absolute model-download bounds", async () => {
		const {
			RECOMMENDED_MODEL_DOWNLOAD_IDLE_TIMEOUT_MS,
			RECOMMENDED_MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
		} = await import("./mobile-device-bridge-bootstrap");
		expect(RECOMMENDED_MODEL_DOWNLOAD_IDLE_TIMEOUT_MS).toBe(300_000);
		expect(RECOMMENDED_MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS).toBe(86_400_000);
	});
});
