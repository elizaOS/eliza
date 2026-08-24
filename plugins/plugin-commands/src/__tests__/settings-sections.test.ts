import { describe, expect, it } from "vitest";
import {
	getSettingsSectionChoices,
	getSettingsSections,
	resolveSettingsSection,
} from "./settings-sections.ts";

describe("getSettingsSections", () => {
	it("returns canonical sections", () => {
		const sections = getSettingsSections();
		expect(sections.length).toBeGreaterThan(5);
		expect(sections.map((s) => s.id)).toContain("ai-model");
		expect(sections.map((s) => s.id)).toContain("permissions");
	});
});

describe("getSettingsSectionChoices", () => {
	it("returns ids only (no aliases)", () => {
		const choices = getSettingsSectionChoices();
		expect(choices).not.toContain("model"); // alias, not id
		expect(choices).toContain("ai-model");
	});
});

describe("resolveSettingsSection", () => {
	it("resolves canonical ids", () => {
		expect(resolveSettingsSection("ai-model")).toBe("ai-model");
	});

	it("resolves aliases", () => {
		expect(resolveSettingsSection("model")).toBe("ai-model");
		expect(resolveSettingsSection("llm")).toBe("ai-model");
		expect(resolveSettingsSection("theme")).toBe("appearance");
		expect(resolveSettingsSection("security")).toBe("permissions");
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(resolveSettingsSection("  VOICE ")).toBe("voice");
	});

	it("returns undefined for unknown or empty tokens", () => {
		expect(resolveSettingsSection("nonexistent")).toBeUndefined();
		expect(resolveSettingsSection("")).toBeUndefined();
		expect(resolveSettingsSection("   ")).toBeUndefined();
	});
});
