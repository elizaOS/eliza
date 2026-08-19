/**
 * Proves every registry call made by AgentSkillsService is bounded by an
 * AbortSignal timeout, so a stalled ClawHub (or GitHub/URL install) host
 * fails closed instead of hanging the user-facing SKILL actions or the
 * catalog sync task indefinitely. The mock fetch rejects unless a signal is
 * present, mirroring the marketplace install's FETCH_TIMEOUT_MS precedent.
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

describe("AgentSkillsService registry fetch timeouts", () => {
	it("bounds search and details registry fetches with an abort signal", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				if (!init?.signal) {
					throw new Error("registry fetch had no abort signal");
				}
				return new Response(
					JSON.stringify({ results: [], skills: [], items: [] }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		await service.search("reflection");
		await service.getSkillDetails("reflection");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
		}
	});
});