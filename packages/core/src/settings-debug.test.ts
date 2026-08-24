import { describe, expect, it } from "vitest";
import {
	isElizaSettingsDebugEnabled,
	sanitizeDebugString,
} from "./settings-debug.js";

describe("settings-debug", () => {
	it("detects enabled via env", () => {
		expect(
			isElizaSettingsDebugEnabled({ env: { ELIZA_SETTINGS_DEBUG: "1" } }),
		).toBe(true);
		expect(
			isElizaSettingsDebugEnabled({
				env: { VITE_ELIZA_SETTINGS_DEBUG: "true" },
			}),
		).toBe(true);
		expect(isElizaSettingsDebugEnabled({ env: {} })).toBe(false);
	});

	it("detects enabled via importMetaEnv", () => {
		expect(
			isElizaSettingsDebugEnabled({
				importMetaEnv: { ELIZA_SETTINGS_DEBUG: "1" },
			}),
		).toBe(true);
		expect(
			isElizaSettingsDebugEnabled({
				importMetaEnv: { VITE_ELIZA_SETTINGS_DEBUG: "on" },
			}),
		).toBe(true);
		expect(isElizaSettingsDebugEnabled({ importMetaEnv: {} })).toBe(false);
	});

	it("sanitizes strings", () => {
		expect(sanitizeDebugString("")).toBe("");
		expect(sanitizeDebugString("[REDACTED]")).toBe("[REDACTED]");
		expect(sanitizeDebugString("  hello  ")).toBe("hello");
		const long = `sk-${"a".repeat(60)}`;
		const masked = sanitizeDebugString(long);
		expect(masked).toContain("chars)");
		expect(masked).not.toBe(long);
	});
});
