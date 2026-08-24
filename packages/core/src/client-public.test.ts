/**
 * Unit tests for client-public subpath: verifies duplicate-safe utility re-exports.
 */
import { describe, expect, it } from "vitest";
import {
	formatError,
	isElizaSettingsDebugEnabled,
	isTruthyEnvValue,
	resolveAliasedEnvValue,
	sanitizeSpeechText,
} from "./client-public.ts";

describe("client-public", () => {
	it("re-exports isTruthyEnvValue", () => {
		expect(isTruthyEnvValue("true")).toBe(true);
		expect(isTruthyEnvValue("1")).toBe(true);
		expect(isTruthyEnvValue("false")).toBe(false);
		expect(isTruthyEnvValue(undefined)).toBe(false);
	});

	it("re-exports sanitizeSpeechText", () => {
		expect(sanitizeSpeechText("Hello world")).toBe("Hello world");
	});

	it("re-exports formatError", () => {
		const formatted = formatError(new Error("sample error"));
		expect(formatted).toContain("sample error");
	});

	it("re-exports resolveAliasedEnvValue", () => {
		expect(typeof resolveAliasedEnvValue).toBe("function");
	});

	it("re-exports isElizaSettingsDebugEnabled", () => {
		expect(typeof isElizaSettingsDebugEnabled).toBe("function");
	});
});
