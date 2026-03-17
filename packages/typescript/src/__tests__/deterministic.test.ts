import { describe, expect, it } from "vitest";
import {
	buildConversationSeed,
	getPromptReferenceDate,
} from "../deterministic";
import type { Memory, State, UUID } from "../types";
import type { IAgentRuntime } from "../types/runtime";

describe("buildConversationSeed", () => {
	it("uses message worldId when state world is missing", () => {
		const runtime = {
			agentId: "11111111-1111-1111-1111-111111111111" as UUID,
			character: {
				id: "22222222-2222-2222-2222-222222222222" as UUID,
			} as IAgentRuntime["character"],
		} as Pick<IAgentRuntime, "agentId" | "character">;

		const message = {
			roomId: "33333333-3333-3333-3333-333333333333" as UUID,
			worldId: "44444444-4444-4444-4444-444444444444" as UUID,
		} as Pick<Memory, "roomId" | "worldId">;

		const seed = buildConversationSeed({
			runtime,
			message,
			surface: "test:seed",
			nowMs: 1_700_000_000_000,
		});

		expect(seed).toContain("44444444-4444-4444-4444-444444444444");
		expect(seed).toContain("33333333-3333-3333-3333-333333333333");
	});

	it("normalizes empty ids to stable fallbacks", () => {
		const runtime = {
			agentId: "55555555-5555-5555-5555-555555555555" as UUID,
			character: {
				id: "" as UUID,
			} as IAgentRuntime["character"],
		} as Pick<IAgentRuntime, "agentId" | "character">;

		const message = {
			roomId: "   " as UUID,
			worldId: "" as UUID,
		} as Pick<Memory, "roomId" | "worldId">;

		const state = {
			data: {
				room: { id: "", worldId: "" },
				world: { id: "   " },
			},
		} as Pick<State, "data">;

		const seed = buildConversationSeed({
			runtime,
			message,
			state,
			surface: "test:seed",
			nowMs: 1_700_000_000_000,
		});

		expect(seed).toContain("room:none");
		expect(seed).toContain("world:none");
		expect(seed).toContain("55555555-5555-5555-5555-555555555555");
	});
});

describe("getPromptReferenceDate", () => {
	it("returns deterministic timestamp inside configured bucket", () => {
		const runtime = {
			agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
			character: {
				id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID,
			} as IAgentRuntime["character"],
			getSetting: (key: string) => {
				if (key === "PROMPT_CACHE_DETERMINISTIC_TIME") {
					return "true";
				}
				if (key === "PROMPT_CACHE_TIME_BUCKET_MS") {
					return "60000";
				}
				return null;
			},
		} as Pick<IAgentRuntime, "agentId" | "character" | "getSetting">;

		const message = {
			roomId: "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID,
			worldId: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
		} as Pick<Memory, "roomId" | "worldId">;

		const state = {
			data: {},
		} as Pick<State, "data">;

		const nowMs = 1_710_000_000_123;
		const first = getPromptReferenceDate({
			runtime,
			message,
			state,
			surface: "provider:time",
			nowMs,
		});
		const second = getPromptReferenceDate({
			runtime,
			message,
			state,
			surface: "provider:time",
			nowMs,
		});

		expect(first.getTime()).toBe(second.getTime());
		const bucketStart = Math.floor(nowMs / 60000) * 60000;
		expect(first.getTime()).toBeGreaterThanOrEqual(bucketStart);
		expect(first.getTime()).toBeLessThan(bucketStart + 60000);
	});
});
