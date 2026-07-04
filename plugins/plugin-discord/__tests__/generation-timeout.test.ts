/**
 * Unit tests for `resolveGenerationTimeoutMs` — precedence of
 * `DISCORD_GENERATION_TIMEOUT_MS` / `MESSAGE_TIMEOUT_MS` / defaults.
 * Pure-function assertions.
 */
import { describe, expect, it } from "vitest";
import { resolveGenerationTimeoutMs } from "../messages.ts";

describe("resolveGenerationTimeoutMs", () => {
	it("defaults to 120s when no settings are provided", () => {
		expect(resolveGenerationTimeoutMs(undefined, undefined)).toBe(120_000);
	});

	it("honors an explicit Discord timeout", () => {
		expect(resolveGenerationTimeoutMs("180000", "3600000")).toBe(180_000);
	});

	it("extends the fallback timeout to cover long media jobs when configured", () => {
		expect(resolveGenerationTimeoutMs(undefined, "120000", "3600000")).toBe(
			3_600_000,
		);
	});

	it("returns null when timeout is disabled with zero", () => {
		expect(resolveGenerationTimeoutMs("0", "120000")).toBeNull();
	});
});
