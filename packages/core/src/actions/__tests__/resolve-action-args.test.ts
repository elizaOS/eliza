/**
 * Exercises action-argument confidence parsing through the public resolver and
 * its real extractor pipeline with a deterministic mocked model response.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { resolveActionArgs, type SubactionsMap } from "../resolve-action-args";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const MESSAGE_ID = "00000000-0000-4000-8000-000000000004" as UUID;

const SUBACTIONS = {
	search: {
		description: "Search saved material.",
		descriptionCompressed: "search saved material",
		required: ["query"],
	},
} as const satisfies SubactionsMap<"search">;

function makeMessage(): Memory {
	return {
		id: MESSAGE_ID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "find the launch notes" },
		createdAt: 1,
	} as Memory;
}

function makeRuntime(confidence: unknown): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
} {
	const useModel = vi.fn(async () =>
		JSON.stringify({
			action: "search",
			params: { query: "launch notes" },
			missing: [],
			confidence,
		}),
	);
	const runtime = {
		agentId: AGENT_ID,
		useModel,
		reportError: vi.fn(),
		logger: { warn: vi.fn() },
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

async function resolveWithConfidence(confidence: unknown) {
	const { runtime, useModel } = makeRuntime(confidence);
	const result = await resolveActionArgs<"search", { query: string }>({
		runtime,
		message: makeMessage(),
		actionName: "SEARCH",
		subactions: SUBACTIONS,
	});
	return { result, useModel };
}

describe("resolveActionArgs confidence parsing", () => {
	it.each([
		"0.8junk",
		"0.8e",
		"0x1",
		"Infinity",
		"NaN",
		"1_0",
		".8",
		"+0.8",
		" 0.75 ",
		"0.75 ",
		"\t0.75",
		"\n0.75",
		"",
		"   ",
	])("rejects malformed confidence string %j", async (confidence) => {
		const { result, useModel } = await resolveWithConfidence(confidence);

		expect(result).toMatchObject({
			ok: false,
			missing: ["subaction"],
			partial: { query: "launch notes" },
		});
		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it.each(["0.5", "0.75", "1", "5e-1"])(
		"accepts complete JSON-number confidence string %j",
		async (confidence) => {
			const { result, useModel } = await resolveWithConfidence(confidence);

			expect(result).toEqual({
				ok: true,
				subaction: "search",
				params: { query: "launch notes" },
			});
			expect(useModel).toHaveBeenCalledTimes(1);
		},
	);

	it.each([0.5, 0.75, 1])(
		"preserves finite numeric confidence %s",
		async (confidence) => {
			const { result } = await resolveWithConfidence(confidence);
			expect(result.ok).toBe(true);
		},
	);

	it.each([
		["-1", false],
		[-1, false],
		["2", true],
		[2, true],
	] as const)(
		"preserves clamping for confidence %j",
		async (confidence, expectedOk) => {
			const { result } = await resolveWithConfidence(confidence);
			expect(result.ok).toBe(expectedOk);
		},
	);
});
