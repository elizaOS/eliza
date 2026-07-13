import { describe, expect, it } from "vitest";
import {
	getSettingsSectionChoices,
	getSettingsSections,
	resolveSettingsSection,
} from "../src/settings-sections";

describe("settings section catalog", () => {
	it("puts Character first and resolves its friendly aliases", () => {
		expect(getSettingsSections()[0]).toMatchObject({
			id: "character",
			label: "Character",
		});
		expect(getSettingsSectionChoices()[0]).toBe("character");
		expect(resolveSettingsSection("character")).toBe("character");
		expect(resolveSettingsSection("persona")).toBe("character");
		expect(resolveSettingsSection("personality")).toBe("character");
	});
});
