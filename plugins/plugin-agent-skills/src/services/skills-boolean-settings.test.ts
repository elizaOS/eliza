/**
 * Pins how the skills service reads its boolean runtime settings. `getSetting`
 * returns `string | boolean | number | null`, and the plugin manifest declares
 * `SKILLS_AUTO_LOAD` as a boolean, so a settings UI stores a real boolean;
 * the service must honour that value the same way it honours the string
 * spelling. Real memory storage, a real seeded skill, no mocks of the service.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySkillStore } from "../storage";
import { AgentSkillsService } from "./skills";

type SettingValue = string | boolean | number | null | undefined;

function runtime(settings: Record<string, SettingValue>): IAgentRuntime {
	return {
		getSetting: vi.fn((key: string) => settings[key] ?? undefined),
		getCache: vi.fn(async () => undefined),
		setCache: vi.fn(async () => true),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

async function seededStore(): Promise<MemorySkillStore> {
	const storage = new MemorySkillStore();
	await storage.savePackage({
		slug: "seeded",
		files: [
			{
				name: "SKILL.md",
				content: "---\nname: seeded\ndescription: seeded body\n---\n\n# seeded body\n",
			},
		],
	});
	return storage;
}

const services: AgentSkillsService[] = [];

afterEach(async () => {
	while (services.length > 0) {
		const service = services.pop();
		if (service) await service.stop();
	}
});

async function startWith(settings: Record<string, SettingValue>): Promise<AgentSkillsService> {
	const service = await AgentSkillsService.start(runtime(settings), {
		storage: await seededStore(),
	});
	services.push(service);
	return service;
}

describe("AgentSkillsService boolean settings", () => {
	it("loads installed skills on start by default", async () => {
		const service = await startWith({});
		expect(service.getLoadedSkill("seeded")?.slug).toBe("seeded");
	});

	it.each([
		["string false", "false"],
		["boolean false", false],
	])("SKILLS_AUTO_LOAD=%s disables loading on start", async (_label, value) => {
		const service = await startWith({ SKILLS_AUTO_LOAD: value });
		expect(service.getLoadedSkill("seeded")).toBeUndefined();
	});

	it.each([
		["string false", "false"],
		["boolean false", false],
	])("CLAWHUB_AUTO_LOAD=%s (the documented alias) disables loading on start", async (_label, value) => {
		const service = await startWith({ CLAWHUB_AUTO_LOAD: value });
		expect(service.getLoadedSkill("seeded")).toBeUndefined();
	});

	it.each([
		["string true", "true"],
		["boolean true", true],
	])("SKILLS_AUTO_LOAD=%s keeps loading on", async (_label, value) => {
		const service = await startWith({ SKILLS_AUTO_LOAD: value });
		expect(service.getLoadedSkill("seeded")?.slug).toBe("seeded");
	});
});
