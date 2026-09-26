import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBootConfig, setBootConfig } from "./config/boot-config-store.js";
import { isElizaSettingsDebugEnabled } from "./settings-debug.js";

const originalBootConfig = getBootConfig();

describe("host settings debug flags", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_SETTINGS_DEBUG", undefined);
		vi.stubEnv("VITE_ELIZA_SETTINGS_DEBUG", undefined);
		setBootConfig({ ...originalBootConfig, envAliases: [] });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		setBootConfig(originalBootConfig);
	});

	it("uses the host flag without accepting renderer build flags", () => {
		vi.stubEnv("VITE_ELIZA_SETTINGS_DEBUG", "true");
		expect(isElizaSettingsDebugEnabled()).toBe(false);
		expect(
			isElizaSettingsDebugEnabled({
				env: { VITE_ELIZA_SETTINGS_DEBUG: "true" },
			}),
		).toBe(false);
		vi.stubEnv("ELIZA_SETTINGS_DEBUG", "enabled");
		expect(isElizaSettingsDebugEnabled()).toBe(true);
	});

	it("preserves explicit host opt-in and process fallback", () => {
		expect(
			isElizaSettingsDebugEnabled({ env: { ELIZA_SETTINGS_DEBUG: "yes" } }),
		).toBe(true);
		vi.stubEnv("ELIZA_SETTINGS_DEBUG", "on");
		expect(isElizaSettingsDebugEnabled({ env: {} })).toBe(true);
	});

	it("resolves a branded host alias while preserving canonical precedence", () => {
		setBootConfig({
			...originalBootConfig,
			envAliases: [["FIXTURE_SETTINGS_DEBUG", "ELIZA_SETTINGS_DEBUG"]],
		});
		vi.stubEnv("FIXTURE_SETTINGS_DEBUG", "true");
		expect(isElizaSettingsDebugEnabled()).toBe(true);
		vi.stubEnv("ELIZA_SETTINGS_DEBUG", "false");
		expect(isElizaSettingsDebugEnabled()).toBe(false);
	});
});
