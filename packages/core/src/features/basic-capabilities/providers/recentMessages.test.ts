import { describe, expect, it, vi } from "vitest";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
} from "../../../types/index.ts";
import { recentMessagesProvider } from "./recentMessages.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";
const USER_ID = "00000000-0000-0000-0000-000000000003";

function makeMemory(
	id: string,
	entityId: string,
	text: string,
	source: string,
	createdAt: number,
	metadata?: Record<string, unknown>,
): Memory {
	return {
		id,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId,
		createdAt,
		content: { text, source, ...(metadata ? { metadata } : {}) },
	} as Memory;
}

function makeRuntime(
	memories: Memory[],
	room: {
		type?: (typeof ChannelType)[keyof typeof ChannelType];
		metadata?: Record<string, unknown>;
		conversationLength?: number;
	} = {},
): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "Agent" },
		getConversationLength: vi.fn(() => room.conversationLength ?? 10),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: room.type ?? ChannelType.GROUP,
			source: "discord",
			metadata: room.metadata ?? {},
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
			{ id: USER_ID, agentId: AGENT_ID, names: ["User"], components: [] },
		]),
		getEntityById: vi.fn(async () => null),
		getMemories: vi.fn(async () => memories),
		getRoomsForParticipants: vi.fn(async () => []),
		getService: vi.fn(() => null),
	} as IAgentRuntime;
}

describe("recentMessagesProvider", () => {
	it("omits internal swarm synthesis bridge rows from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "done", "swarm_synthesis", 2000),
			makeMemory("msg-3", AGENT_ID, "done", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("Agent: done");
		expect(result.text?.match(/Agent: done/g)).toHaveLength(1);
	});

	it("omits prior sub-agent router transcripts from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				"00000000-0000-0000-0000-000000000004",
				"[sub-agent: app build (opencode) — task_complete]\n[tool output: list files]\nnoisy transcript",
				"acpx:sub-agent-router",
				2000,
				{ subAgent: true },
			),
			makeMemory("msg-3", AGENT_ID, "https://example.com/app", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("Agent: https://example.com/app");
		expect(result.text).not.toContain("[sub-agent:");
		expect(result.text).not.toContain("noisy transcript");
	});

	it("omits consecutive duplicate dialogue rows from the same sender", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "are you there?", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "yes", "runtime", 2000),
			makeMemory("msg-3", AGENT_ID, " yes ", "discord", 3000),
			makeMemory("msg-4", USER_ID, "next task", "discord", 4000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "status", "discord", 5000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(3);
		expect(result.text?.match(/Agent: yes/g)).toHaveLength(1);
		expect(result.text).toContain("User: next task");
	});

	it("includes persisted compact ledger even when raw history is not pruned", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "current tail", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				metadata: {
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- parcel LIME-4421",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("# Conversation Compact Ledger");
		expect(result.text).toContain("LIME-4421");
		expect(result.text).toContain("User: current tail");
	});

	it("includes compact ledger in feed/thread post-format prompts", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "thread post", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				type: ChannelType.THREAD,
				metadata: {
					lastCompactionAt: 999,
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- thread code BLUE-77",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.values?.recentPosts).toContain(
			"# Conversation Compact Ledger",
		);
		expect(result.text).toContain("BLUE-77");
		expect(result.text).toContain("# Posts in Thread");
	});

	it("sorts memories by timestamp before applying the conversation window", async () => {
		const memories = Array.from({ length: 12 }, (_, index) => {
			const n = 12 - index;
			return makeMemory(
				`msg-${n}`,
				USER_ID,
				`message ${n}`,
				"discord",
				n * 1000,
			);
		});

		const result = await recentMessagesProvider.get(
			makeRuntime(memories, { conversationLength: 3 }),
			makeMemory("current", USER_ID, "status", "discord", 13_000),
			{ values: {}, data: {}, text: "" },
		);

		const recentMessages = result.data?.recentMessages as Memory[];
		expect(recentMessages.map((memory) => memory.id)).toEqual([
			"msg-10",
			"msg-11",
			"msg-12",
		]);
		expect(result.text).toContain("User: message 12");
		expect(result.text).not.toContain("User: message 9");
	});
});
