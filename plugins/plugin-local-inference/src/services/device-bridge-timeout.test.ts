/**
 * ELIZA_DEVICE_GENERATE_TIMEOUT_MS is also read by the independent
 * plugin-capacitor-bridge device bridge (see its
 * mobile-device-bridge-bootstrap.timeout-validation.test.ts /
 * .timeout-wiring.test.ts). This file proves the same input is accepted or
 * rejected consistently here too - resolveDeviceTimeoutMs() runs before any
 * device lookup, so both generate() and embed() reject immediately on
 * malformed configuration even with zero devices connected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBridge } from "./device-bridge";

const ENV_KEY = "ELIZA_DEVICE_GENERATE_TIMEOUT_MS";
const originalValue = process.env[ENV_KEY];

afterEach(() => {
	if (originalValue === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalValue;
});

describe("DeviceBridge device-generate timeout validation", () => {
	it.each(["600000oops", "1.5", "1e3", "0", "-1", "Infinity"])(
		"rejects malformed %s before any device lookup, for both generate and embed",
		async (value) => {
			process.env[ENV_KEY] = value;
			const bridge = new DeviceBridge();

			await expect(bridge.generate({ prompt: "probe" })).rejects.toMatchObject({
				code: "INVALID_DEVICE_BRIDGE_TIMEOUT",
			});
			await expect(bridge.embed({ input: "probe" })).rejects.toMatchObject({
				code: "INVALID_DEVICE_BRIDGE_TIMEOUT",
			});
		},
	);

	it("uses the exact configured value for a live generate() call, not the 60s default", async () => {
		const configuredMs = 38_417;
		process.env[ENV_KEY] = String(configuredMs);
		const bridge = new DeviceBridge();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

		// No device is connected - this rejects on the scheduled timeout, but
		// the assertion only needs the delay setTimeout was actually called
		// with, so it's cleared below without waiting for the real 38s.
		const pending = bridge.generate({ prompt: "wiring probe" });
		pending.catch(() => {});

		const callIndex = setTimeoutSpy.mock.calls.findIndex(
			(c) => c[1] === configuredMs,
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 60_000)).toBe(false);

		// Clean up the scheduled timer so it doesn't fire after the test ends.
		const timeoutHandle = setTimeoutSpy.mock.results[callIndex]
			?.value as ReturnType<typeof setTimeout>;
		clearTimeout(timeoutHandle);
		setTimeoutSpy.mockRestore();
	});
});
