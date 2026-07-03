import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { characterProvider } from "./character.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";

function createRuntime(topics: string[]): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: {
			name: "Eliza",
			bio: ["A helpful agent."],
			topics,
		},
		getRoom: vi.fn(async () => ({ id: ROOM_ID, type: ChannelType.GROUP })),
	} as IAgentRuntime;
}

function createMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010",
		agentId: AGENT_ID,
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: ROOM_ID,
		content: { text: "hi", source: "discord" },
	} as Memory;
}

const EMPTY_STATE = { values: {}, data: {}, text: "" } as State;

describe("CHARACTER provider topics formatting", () => {
	it("omits the 'is also interested in' sentence when the picked topic is the only topic", async () => {
		const result = await characterProvider.get(
			createRuntime(["chess"]),
			createMessage(),
			EMPTY_STATE,
		);

		// The single topic is consumed as the current topic...
		expect(result.values?.topic).toBe("chess");
		// ...so there are no OTHER topics: no dangling
		// "Eliza is also interested in " fragment may be rendered.
		expect(result.values?.topics).toBe("");
		expect(result.text).not.toMatch(/is also interested in\s*(\n|$)/);
	});

	it("still renders the other-topics sentence when more topics exist", async () => {
		const result = await characterProvider.get(
			createRuntime(["chess", "go", "poker"]),
			createMessage(),
			EMPTY_STATE,
		);

		const topics = result.values?.topics as string;
		expect(topics).toContain("Eliza is also interested in ");
		// The sentence actually names at least one topic after the lead-in.
		expect(topics).toMatch(/is also interested in \S/);
		// The currently-picked topic is excluded from the "also" list.
		expect(topics).not.toContain(result.values?.topic as string);
	});
});
