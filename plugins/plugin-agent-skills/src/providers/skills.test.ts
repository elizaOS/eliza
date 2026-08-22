/**
 * Unit tests for the skill summary, instructions, and catalog-awareness
 * providers, driven against a hand-built runtime stub (no live model).
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { SkillCatalogEntry } from "../types";
import { enabledSkillsProvider } from "./enabled-skills";
import {
	catalogAwarenessProvider,
	skillInstructionsProvider,
	skillsSummaryProvider,
} from "./skills";

function message(text: string): Memory {
	return {
		agentId: "agent-1",
		entityId: "user-1",
		roomId: "room-1",
		content: { text },
	} as Memory;
}

function runtimeWithCatalog(catalog: SkillCatalogEntry[]): IAgentRuntime {
	return {
		getService: vi.fn((name: string) => {
			if (name !== "AGENT_SKILLS_SERVICE") return undefined;
			return {
				getCatalog: vi.fn(async () => catalog),
			};
		}),
	} as unknown as IAgentRuntime;
}

function skill(
	slug: string,
	displayName: string,
	summary: string,
): SkillCatalogEntry {
	return {
		slug,
		displayName,
		summary,
		version: "1.0.0",
		tags: {},
		stats: { downloads: 0, stars: 0 },
		updatedAt: 0,
	};
}

describe("agent_skills_catalog provider", () => {
	it("opts heavyweight skill providers out of default plugin registration", () => {
		expect(skillsSummaryProvider.registerByDefault).toBe(false);
		expect(skillInstructionsProvider.registerByDefault).toBe(false);
		expect(catalogAwarenessProvider.registerByDefault).toBe(false);
	});

	it("does not gate selected catalog context on English capability keywords", async () => {
		const result = await catalogAwarenessProvider.get(
			runtimeWithCatalog([
				skill("browser-helper", "Browser Helper", "Browse and scrape web pages"),
				skill("task-helper", "Task Helper", "Manage task lists"),
			]),
			message("que habilidades tienes disponibles"),
			{ values: { selectedContexts: ["settings"] } } as unknown as State,
		);

		expect(result.text).toContain("## Available Skill Categories");
		expect(result.text).toContain("Browser Helper");
		expect(result.text).toContain("Task Helper");
		expect(result.data?.categories).toMatchObject({
			"Browser & Web": [{ slug: "browser-helper", name: "Browser Helper" }],
			Productivity: [{ slug: "task-helper", name: "Task Helper" }],
		});
	});

	it("returns empty text when no skills service is registered", async () => {
		const result = await catalogAwarenessProvider.get(
			{ getService: () => undefined } as unknown as IAgentRuntime,
			message("what skills do you have"),
			{} as State,
		);

		expect(result).toEqual({ text: "" });
	});

	it("returns empty text when the catalog is empty", async () => {
		const result = await catalogAwarenessProvider.get(
			runtimeWithCatalog([]),
			message("what skills do you have"),
			{} as State,
		);

		expect(result).toEqual({ text: "" });
	});
});

describe("skillInstructionsProvider", () => {
	it("preserves complete active skill instructions", async () => {
		const longInstructions = `${"a".repeat(3999)}🦊${"b".repeat(50)}`;
		const service = {
			getLoadedSkills: vi.fn(() => [
				{
					slug: "weather-pro",
					name: "Weather Pro",
					description: "Use when checking weather",
				},
			]),
			getSkillInstructions: vi.fn(() => ({
				body: longInstructions,
				estimatedTokens: 1000,
			})),
		};
		const runtime = {
			getService: vi.fn((name: string) => {
				if (name !== "AGENT_SKILLS_SERVICE") return undefined;
				return service;
			}),
		} as unknown as IAgentRuntime;

		const result = await skillInstructionsProvider.get(
			runtime,
			message("weather-pro"),
			{} as State,
		);

		expect(result.text.isWellFormed()).toBe(true);
		expect(result.text).toContain(longInstructions);
		expect(result.text).not.toContain("...[truncated]");
	});
});

describe("enabledSkillsProvider", () => {
	it("keeps surrogate pairs intact and sanitizes lone surrogates in descriptions", async () => {
		const longDescription = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
		const service = {
			getEligibleSkills: vi.fn(async () => [
				{
					slug: "custom-skill",
					name: "Custom Skill",
					description: longDescription,
				},
				{
					slug: "lone-skill",
					name: "Lone Skill",
					description: `bad ${String.fromCharCode(0xd800)} description`,
				},
			]),
			isSkillEnabled: vi.fn(() => true),
		};
		const runtime = {
			getService: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? service : undefined,
			),
		} as unknown as IAgentRuntime;

		const result = await enabledSkillsProvider.get(
			runtime,
			message("skills"),
			{} as State,
		);

		expect(result.text.isWellFormed()).toBe(true);
		expect(result.text).toContain(longDescription);
		expect(result.text).toContain("bad \uFFFD description");
	});
});
