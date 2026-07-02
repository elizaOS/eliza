// Regression: the capacitor-llama TEXT handlers must NOT be registered while
// nothing can serve them. On Android the WebView-side llama-cpp-capacitor
// plugin is retired (#9560 one-bionic-path cutover), so the WS device bridge
// can never attach; if the handlers register anyway they win `useModel`
// routing at priority 0 and every chat turn dies with
// "DEVICE_DISCONNECTED: no Capacitor llama device bridge attached" (#11277).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SERVICE_ENABLED is read at module load, so enable the bridge before importing.
process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";

const ENV_KEYS = [
	"ELIZA_LOCAL_LLAMA",
	"ELIZA_BIONIC_HOST_DELEGATED",
	"ELIZA_BIONIC_INFERENCE_SOCK",
];
const saved: Record<string, string | undefined> = {};

function fakeRuntime() {
	return {
		registerModel: vi.fn(),
		getModel: vi.fn(() => undefined),
	};
}

describe("ensureMobileDeviceBridgeInferenceHandlers — dead-bridge gating (#11277)", () => {
	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
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
});
