/**
 * The long-term memory section embeds its own copy of the room conversation
 * only when the shared evaluator context carries none; otherwise it points at
 * the shared rendering. Pure prompt-builder test with runtime doubles; no
 * database or model.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { longTermMemoryEvaluator } from "./memory-items.ts";

const AGENT = "00000000-0000-0000-0000-0000000000a0" as UUID;
const USER = "00000000-0000-0000-0000-0000000000b0" as UUID;
const runtime = {
	agentId: AGENT,
	character: { name: "Eliza" },
} as unknown as IAgentRuntime;
const prepared = {
	memoryService: {},
	recentMessages: [
		{
			id: "00000000-0000-0000-0000-000000000001" as UUID,
			entityId: USER,
			content: { text: "I moved to Lisbon last week", senderName: "Nubs" },
		},
		{
			id: "00000000-0000-0000-0000-000000000002" as UUID,
			entityId: AGENT,
			content: { text: "Congrats on the move!" },
		},
	] as Memory[],
	existingMemories: "None yet",
	currentMessageCount: 2,
};

function buildPrompt(shared: { roomTranscriptRendered: boolean } | undefined) {
	return longTermMemoryEvaluator.prompt({
		runtime,
		prepared,
		shared,
	} as never);
}

describe("long-term memory section transcript", () => {
	it("points at the shared rendering when the conversation is already in the prompt", () => {
		const prompt = buildPrompt({ roomTranscriptRendered: true });
		expect(prompt).toContain('Recent messages: see "Room transcript"');
		expect(prompt).not.toContain("I moved to Lisbon last week");
		expect(prompt).toContain("Existing long-term memories:\nNone yet");
	});

	it("embeds its own complete copy when no shared rendering exists", () => {
		for (const shared of [undefined, { roomTranscriptRendered: false }]) {
			const prompt = buildPrompt(shared);
			expect(prompt).toContain(
				"Recent messages:\nNubs: I moved to Lisbon last week\nEliza: Congrats on the move!",
			);
		}
	});
});
