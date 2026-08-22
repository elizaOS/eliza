/**
 * Covers `ramHeadroomReserveMb` env parsing. The reserve is subtracted from host
 * RAM before a model's fit is judged, so a silently truncated value removes the
 * safety margin that refuses an oversized load.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { localInferencePlugin } from "../provider";
import { ramHeadroomReserveMb } from "./ram-budget";

const KEY = "ELIZA_LOCAL_RAM_HEADROOM_MB";
const original = process.env[KEY];

afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe("ramHeadroomReserveMb", () => {
	it("uses the default only when the override is absent", () => {
		delete process.env[KEY];
		expect(ramHeadroomReserveMb()).toBe(1536);
	});

	it("still honours a clean reserve, including an explicit zero", () => {
		process.env[KEY] = "2048";
		expect(ramHeadroomReserveMb()).toBe(2048);
		process.env[KEY] = "0";
		expect(ramHeadroomReserveMb()).toBe(0);
	});

	it("still honours an explicitly signed positive reserve", () => {
		// `Number.parseInt` accepted "+2048"; rejecting it would be a regression.
		process.env[KEY] = "+2048";
		expect(ramHeadroomReserveMb()).toBe(2048);
	});

	it.each([
		"",
		"   ",
		"1junk",
		"2048MB",
		"2048.7",
		"2 048",
		"2_048",
		"-1",
		"9007199254740993",
	])("rejects the explicit malformed reserve %j", (configured) => {
		process.env[KEY] = configured;

		expect(() => ramHeadroomReserveMb()).toThrowError(ElizaError);
		try {
			ramHeadroomReserveMb();
		} catch (error) {
			expect(error).toMatchObject({
				code: "INVALID_LOCAL_RAM_HEADROOM",
				context: { envKey: KEY, configured },
				severity: "fatal",
			});
		}
	});

	it("surfaces malformed configuration through plugin startup", async () => {
		process.env[KEY] = "2048MB";
		if (!localInferencePlugin.init) {
			throw new Error("local-inference plugin has no startup initializer");
		}

		await expect(
			localInferencePlugin.init({}, {} as IAgentRuntime),
		).rejects.toMatchObject({ code: "INVALID_LOCAL_RAM_HEADROOM" });
	});
});
