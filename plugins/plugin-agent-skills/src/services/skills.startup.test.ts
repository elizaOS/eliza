/**
 * Verifies startup loads local Agent Skills without an implicit registry call,
 * while preserving the explicit catalog-sync opt-in.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySkillStore } from "../storage";
import { AgentSkillsService } from "./skills";

function createRuntime(
	settings: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getSetting: vi.fn((key: string) => settings[key]),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Agent Skills startup catalog policy", () => {
	it("does not contact the remote registry by default", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("syncs during startup only when explicitly enabled", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ items: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await AgentSkillsService.start(
			createRuntime({ SKILLS_SYNC_CATALOG_ON_START: true }),
			{
				autoLoad: false,
				storage: new MemorySkillStore(),
			},
		);

		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
