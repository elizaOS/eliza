/**
 * Verifies Agent Skills startup is strictly local and never performs network
 * discovery, even when unrelated settings are present.
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

describe("Agent Skills local startup policy", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does not contact the network", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		expect(fetchMock).not.toHaveBeenCalled();
		await service.stop();
	});
});
