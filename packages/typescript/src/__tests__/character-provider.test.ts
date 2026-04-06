/**
 * Unit tests for the CHARACTER provider.
 */
import { describe, expect, it, vi } from "vitest";
import { characterProvider } from "../basic-capabilities/providers/character.ts";
import type {
	Character,
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
} from "../types/index.ts";
import { ChannelType } from "../types/index.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TEST_ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeCharacter(overrides: Partial<Character> = {}): Character {
	return {
		name: "Sakuya",
		bio: [],
		plugins: [],
		secrets: {},
		...overrides,
	} as Character;
}

function makeState(roomType: ChannelType = ChannelType.DM): State {
	return {
		values: {},
		data: {
			room: { type: roomType } as Room,
		},
	} as State;
}

function makeRuntime(character: Character): IAgentRuntime {
	return {
		character,
		getRoom: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
	} as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
	return { roomId: TEST_ROOM_ID } as Memory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("characterProvider", () => {
	it("passes through strings without {{name}} unchanged", async () => {
		const character = makeCharacter({
			bio: ["A helpful assistant with no placeholders."],
			system: "You are an AI assistant.",
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		expect(result.values.system).toBe("You are an AI assistant.");
		const text = result.text as string;
		expect(text).toContain("A helpful assistant with no placeholders.");
	});

	it("handles empty character fields gracefully", async () => {
		const character = makeCharacter({
			bio: [],
			topics: [],
			adjectives: [],
			postExamples: [],
			messageExamples: [],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		// Should not throw and should return valid result
		expect(result.values.agentName).toBe("Sakuya");
		expect(result.values.system).toBe("");
	});

	it("uses agentName consistently in all headers", async () => {
		const character = makeCharacter({
			bio: ["{{name}} is cool."],
			style: {
				all: ["Be cool."],
				chat: ["Chat cool."],
				post: ["Post cool."],
			},
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		const text = result.text as string;
		expect(text).toContain("# About Sakuya");
		expect(text).toContain("Sakuya is cool.");
		expect(result.values.agentName).toBe("Sakuya");
	});

	it("resolves {{agentName}} placeholders in character content", async () => {
		const character = makeCharacter({
			bio: ["{{agentName}} stays calm."],
			system: "Speak as {{agentName}} would.",
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		const text = result.text as string;
		expect(text).toContain("Sakuya stays calm.");
		expect(result.values.system).toBe("Speak as Sakuya would.");
	});

	it("resolves example participant placeholders in message examples", async () => {
		const character = makeCharacter({
			messageExamples: [
				{
					examples: [
						{
							name: "{{agentName}}",
							content: { text: "hi {{user1}}" },
						},
						{
							name: "{{user1}}",
							content: { text: "hey {{agentName}}" },
						},
					],
				},
			],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		const text = result.text as string;
		expect(text).toContain("Sakuya:");
		expect(text).not.toContain("{{agentName}}");
		expect(text).not.toContain("{{user1}}");
	});

	it("stays deterministic for the same conversation", async () => {
		const character = makeCharacter({
			bio: ["first", "second", "third"],
			topics: ["alpha", "beta", "gamma"],
			adjectives: ["calm", "sharp"],
			postExamples: ["one", "two", "three"],
			messageExamples: [
				{
					examples: [
						{ name: "{{agentName}}", content: { text: "hi {{user1}}" } },
						{ name: "{{user1}}", content: { text: "yo {{agentName}}" } },
					],
				},
				{
					examples: [
						{ name: "{{agentName}}", content: { text: "hello {{user1}}" } },
						{ name: "{{user1}}", content: { text: "hey {{agentName}}" } },
					],
				},
			],
		});
		const runtime = makeRuntime(character);
		const message = makeMessage();

		const first = await characterProvider.get(runtime, message, makeState());
		const second = await characterProvider.get(runtime, message, makeState());

		expect(first.text).toBe(second.text);
		expect(first.values.topics).toBe(second.values.topics);
		expect(first.values.adjective).toBe(second.values.adjective);
	});
});
