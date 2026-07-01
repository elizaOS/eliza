/**
 * Unit coverage for resolvePowerSourceState's env-override contract (#9147 voice).
 *
 * resolvePowerSourceState gates the optimistic-decode power policy. Its
 * `ELIZA_VOICE_POWER_SOURCE` override is the deterministic, cross-platform path
 * (the `/sys/class/power_supply` probe is Linux-only and environment-dependent,
 * so it is not asserted here). Was untested. No GGUF / audio.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePowerSourceState } from "./optimistic-policy";

const STATES = ["plugged-in", "battery", "unknown"] as const;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolvePowerSourceState — ELIZA_VOICE_POWER_SOURCE override", () => {
	it("honors each valid override value verbatim", () => {
		for (const state of STATES) {
			vi.stubEnv("ELIZA_VOICE_POWER_SOURCE", state);
			expect(resolvePowerSourceState()).toBe(state);
		}
	});

	it("trims and lowercases the override", () => {
		vi.stubEnv("ELIZA_VOICE_POWER_SOURCE", "  BATTERY ");
		expect(resolvePowerSourceState()).toBe("battery");
	});

	it("ignores an invalid override and still returns a valid state", () => {
		vi.stubEnv("ELIZA_VOICE_POWER_SOURCE", "nonsense");
		expect(STATES).toContain(resolvePowerSourceState());
	});
});
