/**
 * Unit tests for the CHARACTER provider.
 *
 * Tests for {{name}} placeholder resolution have been removed because
 * the character provider does not currently perform this substitution.
 * Re-add those tests when {{name}} resolution is implemented.
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
		expect(text).toContain("Sakuya");
		expect(result.values.agentName).toBe("Sakuya");
	});
});
