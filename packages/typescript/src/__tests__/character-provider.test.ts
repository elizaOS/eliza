/**
 * Unit tests for the CHARACTER provider's `{{name}}` placeholder resolution.
 *
 * The character provider replaces `{{name}}` in bio, system, topics,
 * adjectives, style, and examples with the character's actual name so
 * character template files stay name-agnostic.
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
// {{name}} resolution in bio
// ---------------------------------------------------------------------------

describe("characterProvider – {{name}} resolution", () => {
	it("resolves {{name}} in bio strings", async () => {
		const character = makeCharacter({
			bio: [
				"{{name}} is a time-stopping maid.",
				"{{name}} works at the Scarlet Devil Mansion.",
			],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		const text = result.text as string;
		expect(text).toContain("Sakuya is a time-stopping maid.");
		expect(text).toContain("Sakuya works at the Scarlet Devil Mansion.");
		expect(text).not.toContain("{{name}}");
	});

	it("resolves {{name}} in system prompt", async () => {
		const character = makeCharacter({
			system: "You are {{name}}, a perfect maid.",
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		expect(result.values.system).toBe("You are Sakuya, a perfect maid.");
		expect(result.values.system).not.toContain("{{name}}");
	});

	it("resolves {{name}} in topics", async () => {
		const character = makeCharacter({
			topics: ["{{name}}'s knives", "time manipulation"],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		const text = result.text as string;
		expect(text).toContain("Sakuya's knives");
		expect(text).not.toContain("{{name}}");
	});

	it("resolves {{name}} in adjectives", async () => {
		const character = makeCharacter({
			adjectives: ["{{name}}-like elegance"],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		expect(result.values.adjective).toBe("Sakuya-like elegance");
	});

	it("resolves {{name}} in style.all entries", async () => {
		const character = makeCharacter({
			style: {
				all: ["Speak as {{name}} would."],
				chat: ["In chat, {{name}} is direct."],
				post: ["When posting, {{name}} is brief."],
			},
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(),
		);
		// Chat context (DM room) → messageDirections includes all + chat
		const directions = result.values.messageDirections as string;
		expect(directions).toContain("Speak as Sakuya would.");
		expect(directions).toContain("In chat, Sakuya is direct.");
		expect(directions).not.toContain("{{name}}");
	});

	it("resolves {{name}} in style.post for feed rooms", async () => {
		const character = makeCharacter({
			style: {
				all: ["{{name}} speaks carefully."],
				chat: [],
				post: ["{{name}} keeps posts short."],
			},
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(ChannelType.FEED),
		);
		const directions = result.values.postDirections as string;
		expect(directions).toContain("Sakuya speaks carefully.");
		expect(directions).toContain("Sakuya keeps posts short.");
		expect(directions).not.toContain("{{name}}");
	});

	it("resolves {{name}} in post examples", async () => {
		const character = makeCharacter({
			postExamples: [
				"{{name}} just cleaned the entire mansion in 3 seconds.",
				"time stops for no one... except {{name}}.",
			],
		});
		const result = await characterProvider.get(
			makeRuntime(character),
			makeMessage(),
			makeState(ChannelType.FEED),
		);
		const text = result.text as string;
		expect(text).toContain("Sakuya just cleaned the entire mansion");
		expect(text).toContain("except Sakuya.");
		expect(text).not.toContain("{{name}}");
	});

	it("resolves {{name}} in message example text and speaker names", async () => {
		const character = makeCharacter({
			messageExamples: [
				{
					examples: [
						{
							name: "{{name}}",
							content: { text: "I am {{name}}, head maid." },
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
		expect(text).toContain("Sakuya: I am Sakuya, head maid.");
		expect(text).not.toContain("{{name}}");
	});

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
		expect(text).toContain("Sakuya");
		expect(result.values.agentName).toBe("Sakuya");
	});
});
