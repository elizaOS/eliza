/**
 * Timeout configuration tests exercise the real mobile bridge resolver without
 * opening a device transport, covering defaults and malformed operator input.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readTimeoutMs } from "./mobile-device-bridge-bootstrap";

const ENV_KEY = "ELIZA_DEVICE_GENERATE_TIMEOUT_MS";

afterEach(() => {
	delete process.env[ENV_KEY];
});

describe("readTimeoutMs", () => {
	it("uses the fallback when the setting is absent or blank", () => {
		expect(readTimeoutMs(ENV_KEY, 600_000)).toBe(600_000);
		process.env[ENV_KEY] = "   ";
		expect(readTimeoutMs(ENV_KEY, 600_000)).toBe(600_000);
	});

	it("accepts canonical positive integer delays through the node timer limit", () => {
		process.env[ENV_KEY] = "600000";
		expect(readTimeoutMs(ENV_KEY, 1)).toBe(600_000);
		process.env[ENV_KEY] = "2147483647";
		expect(readTimeoutMs(ENV_KEY, 1)).toBe(2_147_483_647);
	});

	it.each(["0", "-1", "1.5", "1e3", "600000oops", "01", "2147483648"])(
		"rejects malformed or out-of-range operator input %s",
		(value) => {
			process.env[ENV_KEY] = value;
			expect(() => readTimeoutMs(ENV_KEY, 600_000)).toThrow(
				`${ENV_KEY} must be a canonical decimal integer from 1 through 2147483647`,
			);
		},
	);
});
